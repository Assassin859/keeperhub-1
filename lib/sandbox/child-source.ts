/**
 * Shared grandchild source for the Code workflow node's sandbox runner.
 *
 * Both the in-pod local path (plugins/code/steps/run-code.ts) and the
 * standalone sandbox service (@keeperhub/sandbox) spawn a disposable Node
 * process via `node -e <SANDBOX_CHILD_SOURCE>` to execute user JS inside a
 * scrubbed vm.createContext sandbox. The two call sites used to inline
 * ~240 lines of this grandchild source verbatim; this module is the single
 * source of truth.
 *
 * Module imports here are restricted to pure data. The exported string is
 * passed intact to `node -e`, so any TypeScript-level import is only
 * usable at template-render time via `JSON.stringify` interpolation - no
 * runtime behaviour can cross into the grandchild because the grandchild
 * has no access to npm or to the rest of this codebase. Importing pure
 * data is the SSRF-blocklist sharing pattern used here (see
 * `lib/ssrf-blocklist.ts`); importing anything with runtime side effects
 * or third-party deps would not propagate to the grandchild.
 *
 * The grandchild uses only node: builtins (node:vm, node:v8, node:dns,
 * node:net) so the downstream sandbox package can remain zero-runtime-dep
 * by design. Adding third-party packages (e.g. undici) would enlarge the
 * supply-chain attack surface of the sandbox container.
 */
// Relative import with explicit `.js` extension. This file is compiled
// by two separate tsconfigs (the keeperhub app and the standalone
// @keeperhub/sandbox package). The sandbox package is `"type": "module"`
// and runs the compiled output via plain `node`, whose strict ESM loader
// requires explicit file extensions in imports - extension-less or
// `@/`-aliased forms fail at runtime with ERR_MODULE_NOT_FOUND. TS
// resolves "../ssrf-blocklist.js" to the matching .ts source at compile
// time (matching the convention used by `sandbox/src/run-code.ts` which
// imports `"../../lib/sandbox/child-source.js"`).
import {
  SSRF_BLOCKED_HOST_EXACT,
  SSRF_BLOCKED_HOST_SUFFIXES,
  SSRF_IPV4_BROADCAST_ADDRESSES,
  SSRF_IPV4_CIDRS,
  SSRF_IPV6_CIDRS,
  SSRF_IPV6_LITERAL_ADDRESSES,
  SSRF_NAT64_PREFIX_CIDR,
} from "../ssrf-blocklist.js";

/**
 * Byte-sequence that prefixes the grandchild's final v8-serialized result
 * on stdout. The parent uses `lastIndexOf(sentinel)` to locate the real
 * result even if user code writes arbitrary bytes to stdout via a sandbox
 * escape — stray writes before the sentinel are ignored.
 */
export const SANDBOX_RESULT_SENTINEL = "RESULT";

/**
 * JavaScript source string for the sandbox grandchild. Passed verbatim to
 * `node -e`, so it must be standalone (no imports, no TypeScript syntax).
 *
 * Responsibilities:
 *   - Read a JSON payload from stdin: `{ code: string, timeoutMs: number }`
 *   - Execute `code` inside a vm.createContext sandbox with a scrubbed set
 *     of globals
 *   - Apply an SSRF guard to `fetch` (DNS-resolved denylist mirroring
 *     lib/safe-fetch.ts from KEEP-314)
 *   - Apply a wall-clock timeout (beyond the vm's sync CPU timeout) that
 *     catches never-settling user promises
 *   - Write a sentinel-prefixed, v8-serialized outcome to stdout
 */
export const SANDBOX_CHILD_SOURCE = `
"use strict";
const { createContext, runInContext } = require("node:vm");
const v8 = require("node:v8");
const dnsPromises = require("node:dns").promises;
const { BlockList, isIP } = require("node:net");

const MAX_LOG_ENTRIES = 200;

// SSRF guard: ported from lib/safe-fetch.ts. Modeled on the main-app
// pattern but inlined here because the sandbox package is
// zero-runtime-dep by design and the grandchild gets only node: builtins.
// Two layers fire before the wrapped fetch dials anything:
//   1. Pre-DNS hostname denylist (isBlockedHost) catches localhost and
//      patterns like *.local, *.internal, *.svc.cluster.local,
//      *.pod.cluster.local. Defense-in-depth on top of the IP check;
//      also surfaces in error messages as the original hostname.
//   2. DNS-resolved IP denylist catches hostnames that resolve to RFC
//      1918, loopback, link-local (IMDS), CGNAT, reserved ranges, ULA,
//      multicast, and the additional IPv6 transition prefixes
//      (64:ff9b:1::/48, 2001::/32 Teredo, 2002::/16 6to4, 2001:db8::/32).
// NAT64 (64:ff9b::/96): the well-known prefix is treated specially. In
// dual-stack / IPv6-preferred pods (typical for our AWS prod VPC) the
// resolver synthesises NAT64 AAAA records for every IPv4-only public
// host (discord.com, slack.com, telegram.org, etc.). Blanket-blocking
// the prefix would block all of them. Instead, on a NAT64 hit we
// extract the embedded IPv4 and recheck it against the IPv4 list —
// preserving the SSRF property without false positives on public IPv4.
// TOCTOU: we do not have undici's per-connect hook (would require adding
// undici as a sandbox dep), so there is a small window between our
// dns.lookup and the fetch's internal connect where the record could
// change. NetworkPolicy is the real defense for that (tracked elsewhere).
// Testing note: the sandbox guard is not unit-tested directly because
// this entire file is a template literal executed in a subprocess via
// "node -e". The parallel behavior in lib/safe-fetch.ts is unit-tested
// (tests/unit/safe-fetch.test.ts) and these CIDR / hostname denylists
// are kept in lockstep with that file by convention.
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const IPV4_MAPPED_PREFIX = "::ffff:";
const IPV4_MAPPED_HEX_REGEX = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
// NAT64 well-known prefix (RFC 6052): 64:ff9b::/96 — last 32 bits encode an
// IPv4. We accept three textual forms a resolver may return.
const NAT64_CANONICAL_REGEX = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const NAT64_UNCOMPRESSED_REGEX = /^64:ff9b:0:0:0:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const NAT64_DOTTED_REGEX = /^64:ff9b::(\\d+\\.\\d+\\.\\d+\\.\\d+)$/;

// CIDR ranges and special prefixes interpolated from
// lib/ssrf-blocklist.ts at module-render time. See that file for the
// rationale on which ranges are blanket-blocked vs handled specially.
// Note: ::ffff:0:0/96 (IPv4-mapped IPv6) is intentionally not added —
// Node treats that subnet as "all IPv4" which would make every IPv4
// check return true. IPv4-mapped IPv6 pointing at private IPv4 is
// caught via the mapped extraction below. The NAT64 well-known prefix
// (64:ff9b::/96) is also kept separate for the same reason - dual-stack
// resolvers synthesise it for every IPv4-only public host, so we extract
// the embedded IPv4 and recheck it against the IPv4 list.
const SSRF_IPV4_CIDRS = ${JSON.stringify(SSRF_IPV4_CIDRS)};
const SSRF_IPV4_BROADCAST_ADDRESSES = ${JSON.stringify(SSRF_IPV4_BROADCAST_ADDRESSES)};
const SSRF_IPV6_LITERAL_ADDRESSES = ${JSON.stringify(SSRF_IPV6_LITERAL_ADDRESSES)};
const SSRF_IPV6_CIDRS = ${JSON.stringify(SSRF_IPV6_CIDRS)};
const SSRF_NAT64_PREFIX_CIDR = ${JSON.stringify(SSRF_NAT64_PREFIX_CIDR)};

const SSRF_BLOCK_LIST = new BlockList();
for (const cidr of SSRF_IPV4_CIDRS) {
  SSRF_BLOCK_LIST.addSubnet(cidr[0], cidr[1], "ipv4");
}
for (const addr of SSRF_IPV4_BROADCAST_ADDRESSES) {
  SSRF_BLOCK_LIST.addAddress(addr, "ipv4");
}
for (const addr of SSRF_IPV6_LITERAL_ADDRESSES) {
  SSRF_BLOCK_LIST.addAddress(addr, "ipv6");
}
for (const cidr of SSRF_IPV6_CIDRS) {
  SSRF_BLOCK_LIST.addSubnet(cidr[0], cidr[1], "ipv6");
}

const NAT64_BLOCK_LIST = new BlockList();
NAT64_BLOCK_LIST.addSubnet(SSRF_NAT64_PREFIX_CIDR[0], SSRF_NAT64_PREFIX_CIDR[1], "ipv6");

function hexGroupsToIpv4(highHex, lowHex) {
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  if (!(Number.isFinite(high) && Number.isFinite(low))) {
    return undefined;
  }
  return [((high >> 8) & 0xff), (high & 0xff), ((low >> 8) & 0xff), (low & 0xff)].join(".");
}

function extractMappedIpv4(ipv6) {
  const lower = ipv6.toLowerCase();
  if (!lower.startsWith(IPV4_MAPPED_PREFIX)) {
    return undefined;
  }
  const suffix = lower.slice(IPV4_MAPPED_PREFIX.length);
  if (isIP(suffix) === 4) {
    return suffix;
  }
  const hexMatch = suffix.match(IPV4_MAPPED_HEX_REGEX);
  if (!hexMatch) {
    return undefined;
  }
  return hexGroupsToIpv4(hexMatch[1] || "", hexMatch[2] || "");
}

function extractNat64Ipv4(ipv6) {
  const lower = ipv6.toLowerCase();
  const canonical = lower.match(NAT64_CANONICAL_REGEX);
  if (canonical && canonical[1] && canonical[2]) {
    return hexGroupsToIpv4(canonical[1], canonical[2]);
  }
  const uncompressed = lower.match(NAT64_UNCOMPRESSED_REGEX);
  if (uncompressed && uncompressed[1] && uncompressed[2]) {
    return hexGroupsToIpv4(uncompressed[1], uncompressed[2]);
  }
  const dotted = lower.match(NAT64_DOTTED_REGEX);
  if (dotted && dotted[1] && isIP(dotted[1]) === 4) {
    return dotted[1];
  }
  return undefined;
}

function isBlockedIp(ip) {
  const family = isIP(ip);
  if (family === 0) {
    return { blocked: false };
  }
  if (family === 6 && NAT64_BLOCK_LIST.check(ip, "ipv6")) {
    const embedded = extractNat64Ipv4(ip);
    if (embedded === undefined) {
      // Inside 64:ff9b::/96 but textual form is unfamiliar — block
      // defensively rather than pass an unvalidated v6 through.
      return { blocked: true, ip: ip };
    }
    if (SSRF_BLOCK_LIST.check(embedded, "ipv4")) {
      return { blocked: true, ip: embedded };
    }
    return { blocked: false };
  }
  const familyKey = family === 4 ? "ipv4" : "ipv6";
  if (SSRF_BLOCK_LIST.check(ip, familyKey)) {
    return { blocked: true, ip: ip };
  }
  if (family === 6) {
    const mapped = extractMappedIpv4(ip);
    if (mapped && SSRF_BLOCK_LIST.check(mapped, "ipv4")) {
      return { blocked: true, ip: mapped };
    }
  }
  return { blocked: false };
}

function stripIpv6Brackets(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

// Pre-DNS hostname denylist interpolated from lib/ssrf-blocklist.ts at
// module-render time. See that module for the rationale (case handling,
// suffix semantics, cluster-domain assumption).
const BLOCKED_HOST_EXACT = new Set(${JSON.stringify(Array.from(SSRF_BLOCKED_HOST_EXACT))});
const BLOCKED_HOST_SUFFIXES = ${JSON.stringify(SSRF_BLOCKED_HOST_SUFFIXES)};

function isBlockedHost(host) {
  if (host === "") {
    return false;
  }
  let normalised = host.trim().toLowerCase();
  if (normalised.endsWith(".")) {
    normalised = normalised.slice(0, -1);
  }
  if (normalised === "") {
    return false;
  }
  if (BLOCKED_HOST_EXACT.has(normalised)) {
    return true;
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (normalised.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

async function checkHostnameSsrf(hostname) {
  if (isBlockedHost(hostname)) {
    return { blocked: true, ip: hostname };
  }
  if (isIP(hostname) !== 0) {
    return isBlockedIp(hostname);
  }
  // all:true catches split-horizon DNS where A and AAAA differ — one
  // private address in the response is enough to reject.
  const records = await dnsPromises.lookup(hostname, { all: true });
  for (const rec of records) {
    const check = isBlockedIp(rec.address);
    if (check.blocked) {
      return check;
    }
  }
  return { blocked: false };
}

function safeCloneArg(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    try {
      return String(value);
    } catch (_e) {
      return "[unserializable]";
    }
  }
}

function run(input) {
  const { code, timeoutMs } = input;
  const logs = [];

  function capture(level) {
    return function capturedLogger() {
      if (logs.length >= MAX_LOG_ENTRIES) {
        return;
      }
      const args = new Array(arguments.length);
      for (let i = 0; i < arguments.length; i++) {
        args[i] = safeCloneArg(arguments[i]);
      }
      logs.push({ level: level, args: args });
    };
  }

  const capturedConsole = {
    log: capture("log"),
    warn: capture("warn"),
    error: capture("error"),
  };

  function extractUrl(resource) {
    if (typeof resource === "string") {
      return resource;
    }
    if (resource && typeof resource.url === "string") {
      return resource.url;
    }
    try {
      return String(resource);
    } catch (_) {
      return "";
    }
  }

  async function sandboxedFetch(resource, init) {
    const url = extractUrl(resource);
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_e) {
      throw new TypeError("sandbox fetch: invalid URL: " + url);
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new Error("sandbox fetch: scheme not allowed: " + parsed.protocol);
    }

    const hostname = stripIpv6Brackets(parsed.hostname);
    const ssrfCheck = await checkHostnameSsrf(hostname);
    if (ssrfCheck.blocked) {
      const targetIp = ssrfCheck.ip;
      const suffix = targetIp && targetIp !== hostname ? " -> " + targetIp : "";
      throw new Error(
        "sandbox fetch: SSRF blocked (" + hostname + suffix + ")"
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(function onTimeout() {
      controller.abort();
    }, timeoutMs);

    const callerSignal = init && init.signal ? init.signal : undefined;
    if (callerSignal && callerSignal.aborted) {
      controller.abort();
    } else if (callerSignal) {
      callerSignal.addEventListener(
        "abort",
        function onCallerAbort() {
          controller.abort();
        },
        { once: true }
      );
    }

    const nextInit = Object.assign({}, init, { signal: controller.signal });
    return fetch(resource, nextInit).finally(function clearTimer() {
      clearTimeout(timer);
    });
  }

  const sandbox = createContext({
    console: capturedConsole,
    fetch: sandboxedFetch,

    BigInt: BigInt, JSON: JSON, Math: Math, Date: Date, Array: Array,
    Object: Object, String: String, Number: Number, Boolean: Boolean,
    RegExp: RegExp, Symbol: Symbol,
    Map: Map, Set: Set, WeakMap: WeakMap, WeakSet: WeakSet, Promise: Promise,

    Error: Error, TypeError: TypeError, RangeError: RangeError,
    SyntaxError: SyntaxError, ReferenceError: ReferenceError, URIError: URIError,

    parseInt: parseInt, parseFloat: parseFloat,
    isNaN: isNaN, isFinite: isFinite, Infinity: Infinity, NaN: NaN,

    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    encodeURI: encodeURI, decodeURI: decodeURI,
    atob: atob, btoa: btoa,
    TextEncoder: TextEncoder, TextDecoder: TextDecoder,

    ArrayBuffer: ArrayBuffer, DataView: DataView,
    Uint8Array: Uint8Array, Uint16Array: Uint16Array, Uint32Array: Uint32Array,
    Int8Array: Int8Array, Int16Array: Int16Array, Int32Array: Int32Array,
    Float32Array: Float32Array, Float64Array: Float64Array,
    BigInt64Array: BigInt64Array, BigUint64Array: BigUint64Array,

    URL: URL, URLSearchParams: URLSearchParams, Headers: Headers,
    Request: Request, Response: Response,
    AbortController: AbortController, AbortSignal: AbortSignal,

    structuredClone: structuredClone, Intl: Intl,
    crypto: { randomUUID: crypto.randomUUID.bind(crypto) },

    SharedArrayBuffer: undefined,
  });

  const wrappedCode = "(async () => {\\n" + code + "\\n})()";

  const userPromise = runInContext(wrappedCode, sandbox, {
    timeout: timeoutMs,
    filename: "user-code.js",
  }).then(
    function onResult(result) {
      return { ok: true, result: result, logs: logs };
    },
    function onError(err) {
      return {
        ok: false,
        errorMessage:
          err && err.message ? String(err.message) : String(err),
        errorStack: err && err.stack ? String(err.stack) : undefined,
        logs: logs,
      };
    }
  );

  // In-child wall-clock timeout. The vm \`timeout\` option only covers sync
  // CPU; a user promise that never settles (e.g. \`await new Promise(() => {})\`)
  // would otherwise let the child exit cleanly with code 0 the moment stdin
  // EOFs and no handles remain, producing a no-result outcome in the parent
  // instead of a timeout. The timer also keeps the event loop alive until a
  // race resolution.
  let timeoutTimer;
  const timeoutPromise = new Promise(function onTimeoutRace(resolveRace) {
    timeoutTimer = setTimeout(function onTimeoutFire() {
      resolveRace({
        ok: false,
        errorMessage:
          "Script execution timed out after " + String(timeoutMs) + " ms",
        logs: logs,
      });
    }, timeoutMs);
  });
  const settledUserPromise = userPromise.finally(function clearTimer() {
    clearTimeout(timeoutTimer);
  });
  return Promise.race([settledUserPromise, timeoutPromise]);
}

function writeResult(message) {
  let payload;
  try {
    payload = v8.serialize(message).toString("base64");
  } catch (cloneErr) {
    payload = v8
      .serialize({
        ok: false,
        errorMessage:
          "Result is not serializable: " +
          (cloneErr && cloneErr.message
            ? cloneErr.message
            : String(cloneErr)),
        errorStack: undefined,
        logs: [],
      })
      .toString("base64");
  }
  // Prefix with sentinel so the parent can ignore stray writes from user code
  // that reaches process.stdout via a sandbox escape.
  process.stdout.write("\\x01RESULT\\x02" + payload + "\\n");
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function onData(chunk) {
  stdinBuf += chunk;
});
process.stdin.on("end", async function onEnd() {
  let input;
  try {
    input = JSON.parse(stdinBuf);
  } catch (e) {
    writeResult({
      ok: false,
      errorMessage: "Bad input to sandbox: " + (e && e.message ? e.message : String(e)),
      logs: [],
    });
    return;
  }
  try {
    const outcome = await run(input);
    writeResult(outcome);
  } catch (err) {
    writeResult({
      ok: false,
      errorMessage: err && err.message ? String(err.message) : String(err),
      errorStack: err && err.stack ? String(err.stack) : undefined,
      logs: [],
    });
  }
});
`;
