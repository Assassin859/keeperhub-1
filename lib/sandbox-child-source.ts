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
 * DO NOT IMPORT anything into this module — the exported string is passed
 * intact to `node -e`, so any `import` statements would not propagate and
 * any value-level logic would not execute in the grandchild. Everything
 * the grandchild needs must be expressed inside the template literal.
 *
 * The grandchild uses only node: builtins (node:vm, node:v8, node:dns,
 * node:net) so the downstream sandbox package can remain zero-runtime-dep
 * by design. Adding third-party packages (e.g. undici) would enlarge the
 * supply-chain attack surface of the sandbox container.
 */

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

// SSRF guard: ported from lib/safe-fetch.ts (KEEP-314). Modeled on the
// main-app pattern but inlined here because the sandbox package is
// zero-runtime-dep by design and the grandchild gets only node: builtins.
// The defense here is DNS-resolved denylist — it catches hostnames that
// resolve to RFC 1918, loopback, link-local (IMDS), CGNAT, and reserved
// ranges, where the old substring check only caught named metadata hosts.
// TOCTOU: we do not have undici's per-connect hook (would require adding
// undici as a sandbox dep), so there is a small window between our
// dns.lookup and the fetch's internal connect where the record could
// change. NetworkPolicy is the real defense for that (tracked elsewhere).
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const IPV4_MAPPED_PREFIX = "::ffff:";
const IPV4_MAPPED_HEX_REGEX = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

const SSRF_BLOCK_LIST = new BlockList();
SSRF_BLOCK_LIST.addSubnet("0.0.0.0", 8, "ipv4");
SSRF_BLOCK_LIST.addSubnet("10.0.0.0", 8, "ipv4");
SSRF_BLOCK_LIST.addSubnet("100.64.0.0", 10, "ipv4");
SSRF_BLOCK_LIST.addSubnet("127.0.0.0", 8, "ipv4");
SSRF_BLOCK_LIST.addSubnet("169.254.0.0", 16, "ipv4");
SSRF_BLOCK_LIST.addSubnet("172.16.0.0", 12, "ipv4");
SSRF_BLOCK_LIST.addSubnet("192.0.0.0", 24, "ipv4");
SSRF_BLOCK_LIST.addSubnet("192.0.2.0", 24, "ipv4");
SSRF_BLOCK_LIST.addSubnet("192.88.99.0", 24, "ipv4");
SSRF_BLOCK_LIST.addSubnet("192.168.0.0", 16, "ipv4");
SSRF_BLOCK_LIST.addSubnet("198.18.0.0", 15, "ipv4");
SSRF_BLOCK_LIST.addSubnet("198.51.100.0", 24, "ipv4");
SSRF_BLOCK_LIST.addSubnet("203.0.113.0", 24, "ipv4");
SSRF_BLOCK_LIST.addSubnet("224.0.0.0", 4, "ipv4");
SSRF_BLOCK_LIST.addSubnet("240.0.0.0", 4, "ipv4");
SSRF_BLOCK_LIST.addAddress("255.255.255.255", "ipv4");
SSRF_BLOCK_LIST.addAddress("::", "ipv6");
SSRF_BLOCK_LIST.addAddress("::1", "ipv6");
// Note: ::ffff:0:0/96 (IPv4-mapped IPv6) not added — Node treats that
// subnet as "all IPv4" which would make every IPv4 check return true.
// IPv4-mapped IPv6 pointing at private IPv4 is caught via the mapped
// extraction below.
SSRF_BLOCK_LIST.addSubnet("64:ff9b::", 96, "ipv6");
SSRF_BLOCK_LIST.addSubnet("100::", 64, "ipv6");
SSRF_BLOCK_LIST.addSubnet("fc00::", 7, "ipv6");
SSRF_BLOCK_LIST.addSubnet("fe80::", 10, "ipv6");
SSRF_BLOCK_LIST.addSubnet("ff00::", 8, "ipv6");

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
  const high = Number.parseInt(hexMatch[1] || "", 16);
  const low = Number.parseInt(hexMatch[2] || "", 16);
  if (!(Number.isFinite(high) && Number.isFinite(low))) {
    return undefined;
  }
  return [((high >> 8) & 0xff), (high & 0xff), ((low >> 8) & 0xff), (low & 0xff)].join(".");
}

function isBlockedIp(ip) {
  const family = isIP(ip);
  if (family === 0) {
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

async function checkHostnameSsrf(hostname) {
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
