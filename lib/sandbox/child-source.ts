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
// The blocklist data is imported as JSON (not as a `.ts` module) because
// this file is compiled by two separate tsconfigs with incompatible
// `.js`/`.ts` resolution conventions: the keeperhub app (Next.js
// Turbopack) wants extension-less imports for `.ts` sources, while the
// standalone @keeperhub/sandbox package is `"type": "module"` and its
// strict ESM runtime requires explicit file extensions. A `.json`
// extension resolves identically in both contexts, so the data lives in
// `lib/ssrf-blocklist.json` and `lib/ssrf-blocklist.ts` is just a typed
// re-export used by the keeperhub-side consumers.
import blocklist from "../ssrf-blocklist.json" with { type: "json" };

/**
 * F-010: the grandchild returns its result as TAGGED JSON on a DEDICATED pipe
 * (fd 3), not stdout. The result is a single length-prefixed frame (4-byte
 * big-endian byte count, then a UTF-8 JSON body) and the parent recovers it
 * with JSON.parse + decodeSandboxResult.
 *
 * Two independent properties close the finding:
 *   - The parent NEVER runs v8.deserialize on bytes the child produced. JSON
 *     is safe to parse on untrusted input (the decoder additionally rebuilds
 *     "__proto__" keys as own data properties, so it cannot be used to pollute
 *     the parent's prototypes). This removes the root cause: even a fully
 *     compromised child can only deliver inert data, never a deserialization
 *     gadget. Fidelity (BigInt/Map/Set/Date/typed arrays/...) is preserved by
 *     the tag codec rather than by structured-clone.
 *   - stdout (fd 1) is left purely user-facing; nothing there is deserialized,
 *     so a sandbox escape writing to stdout cannot masquerade as a result (the
 *     old design scanned stdout for a 6-byte sentinel via lastIndexOf, which
 *     an escaped child defeated by appending a later sentinel). The parent
 *     also accepts only the FIRST complete fd-3 frame, and the genuine frame
 *     is written through a fs.writeSync reference captured at child startup,
 *     so a post-escape forged frame -- even with process.exit/fs.writeSync
 *     reassigned -- loses to the genuine one.
 *
 * Residual: a sandbox escape is still arbitrary code running AS the user, so
 * it can return any DATA it likes (exactly as legitimate user code can). What
 * it can no longer do is hand the parent untrusted bytes to deserialize. The
 * vector is gated behind a vm escape; the child is env-scrubbed and
 * NetworkPolicy-isolated.
 */
export const SANDBOX_RESULT_FD = 3;

/** Width of the big-endian length prefix on the fd-3 result frame. */
const SANDBOX_RESULT_HEADER_BYTES = 4;

/**
 * Upper bound on the declared frame length the parent will buffer. Checked
 * against the length prefix before any payload bytes are accumulated, so a
 * malicious child cannot pin parent memory by declaring a huge frame. The
 * child process is itself memory-bounded, so legitimate results never
 * approach this; it is a denial-of-service backstop, not a product limit.
 */
export const SANDBOX_RESULT_MAX_BYTES = 96 * 1024 * 1024;

/**
 * Identifier for the HTTP wire format between the main app and the standalone
 * sandbox service (JSON request + tagged-JSON response). The client sends it as
 * the `X-Sandbox-Wire` request header and the server echoes it on the response;
 * each side rejects a mismatch so a deploy-time version skew fails fast with a
 * clear error instead of a confusing parse failure. Bump when the wire changes.
 */
export const SANDBOX_WIRE_VERSION = "json-v1";

export type SandboxResultReader = {
  /** Feed a chunk from the parent's fd-3 stream. Chunks after the first
   * complete frame are ignored (first-frame-wins). */
  push: (chunk: Buffer) => void;
  /** The first complete frame's v8 bytes, or null until one is complete. */
  readonly frame: Buffer | null;
  /** True once the first frame is complete or the stream is known-malformed. */
  readonly done: boolean;
  /** Set when the declared length exceeds SANDBOX_RESULT_MAX_BYTES. */
  readonly error: string | null;
};

/**
 * Streaming reader for the fd-3 result frame. The parent attaches it to the
 * child's fd-3 pipe and resolves as soon as `done` is true with a non-null
 * `frame`. Only the first length-prefixed frame is read; any trailing bytes
 * (e.g. a forged frame a sandbox escape appends later) are discarded.
 */
export function createSandboxResultReader(
  maxBytes: number = SANDBOX_RESULT_MAX_BYTES
): SandboxResultReader {
  let chunks: Buffer[] = [];
  let size = 0;
  let frame: Buffer | null = null;
  let done = false;
  let error: string | null = null;

  return {
    push(chunk: Buffer): void {
      if (done) {
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
      if (size < SANDBOX_RESULT_HEADER_BYTES) {
        return;
      }
      const buf =
        chunks.length === 1
          ? (chunks[0] as Buffer)
          : Buffer.concat(chunks, size);
      chunks = [buf];
      const declared = buf.readUInt32BE(0);
      if (declared > maxBytes) {
        error = `Sandbox result exceeds maximum size (${declared} > ${maxBytes} bytes)`;
        done = true;
        return;
      }
      const total = SANDBOX_RESULT_HEADER_BYTES + declared;
      if (buf.length >= total) {
        frame = buf.subarray(SANDBOX_RESULT_HEADER_BYTES, total);
        done = true;
      }
    },
    get frame(): Buffer | null {
      return frame;
    },
    get done(): boolean {
      return done;
    },
    get error(): string | null {
      return error;
    },
  };
}

/**
 * Tag key for the result codec. The child encodes its outcome as tagged JSON
 * (see `encodeResult` in the template) so the parent can recover it with a
 * SAFE `JSON.parse` instead of `v8.deserialize` -- which Node documents as
 * unsafe on untrusted data. A 1-key `{ "$": <tag> }` object carries a typed
 * value (bigint, Date, Map, ...); plain user objects that happen to contain a
 * literal "$" key are escaped as `{ "$": "obj", "v": {...} }` so they cannot
 * be mistaken for a tag.
 */
const SANDBOX_RESULT_TAG = "$";

function reviveSandboxNumber(token: string): number {
  switch (token) {
    case "NaN":
      return Number.NaN;
    case "Inf":
      return Number.POSITIVE_INFINITY;
    case "-Inf":
      return Number.NEGATIVE_INFINITY;
    case "-0":
      return -0;
    default:
      return Number(token);
  }
}

/**
 * Allowlisted view constructors the decoder will instantiate from a "bytes"
 * tag. The sandbox payload is UNTRUSTED, so the decoder never resolves an
 * arbitrary global by name: a forged `k` such as "fetch" would otherwise let a
 * compromised child select any global constructor (`new fetch(ab)` returns a
 * promise that rejects unhandled and can crash the process via the server's
 * unhandledRejection handler). Anything off this list falls back to raw bytes.
 */
const SANDBOX_VIEW_CTORS: Record<
  string,
  new (buffer: ArrayBuffer) => ArrayBufferView
> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

function reviveSandboxBytes(kind: string, base64: string): unknown {
  const buf = Buffer.from(base64, "base64");
  // Copy into a standalone ArrayBuffer so the result does not alias Node's
  // shared Buffer pool.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (kind === "ArrayBuffer") {
    return ab;
  }
  const Ctor: (new (buffer: ArrayBuffer) => ArrayBufferView) | undefined =
    SANDBOX_VIEW_CTORS[kind];
  if (Ctor) {
    try {
      return new Ctor(ab);
    } catch {
      // A known kind whose byte length is not a multiple of its element size
      // (a forged/malformed frame would make `new Uint32Array(ab)` throw):
      // hand back raw bytes rather than throwing on the untrusted boundary.
      return new Uint8Array(ab);
    }
  }
  // Unknown/forged view kind: never resolve an arbitrary global by name; hand
  // back raw bytes rather than instantiating it.
  return new Uint8Array(ab);
}

/**
 * Rebuild a plain object key-by-key, defining each property so a "__proto__"
 * key lands as an own data property instead of invoking the prototype setter
 * (the prototype-pollution guard that makes deserializing untrusted input
 * safe).
 */
function decodeSandboxObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    Object.defineProperty(result, key, {
      value: decodeSandboxNode(obj[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function decodeSandboxNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(decodeSandboxNode);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const obj = node as Record<string, unknown>;
  if (!Object.hasOwn(obj, SANDBOX_RESULT_TAG)) {
    return decodeSandboxObject(obj);
  }
  switch (obj[SANDBOX_RESULT_TAG]) {
    case "undef":
      return undefined;
    case "bigint":
      return BigInt(obj.v as string);
    case "num":
      return reviveSandboxNumber(obj.v as string);
    case "date":
      // A non-number v means an Invalid Date: every encoder emits
      // value.getTime(), and JSON.stringify(NaN) === null, so an Invalid Date
      // arrives as null. Revive it as Invalid Date rather than coercing null
      // (new Date(null)) to the Unix epoch.
      return new Date(typeof obj.v === "number" ? obj.v : Number.NaN);
    case "regexp":
      return new RegExp(obj.src as string, obj.flags as string);
    case "map":
      return new Map(
        (obj.v as [unknown, unknown][]).map((e) => [
          decodeSandboxNode(e[0]),
          decodeSandboxNode(e[1]),
        ])
      );
    case "set":
      return new Set((obj.v as unknown[]).map(decodeSandboxNode));
    case "bytes":
      return reviveSandboxBytes(obj.k as string, obj.v as string);
    case "obj":
      // Escaped plain object: its keys are literal data, never tags.
      return decodeSandboxObject(obj.v as Record<string, unknown>);
    default:
      // Unknown tag from a malformed/compromised child: treat as plain data.
      return decodeSandboxObject(obj);
  }
}

/**
 * Parse a child result frame. `text` is the UTF-8 body of the fd-3 frame.
 * Uses `JSON.parse` (safe on untrusted input) and rebuilds the typed values
 * the child tagged. Throws on malformed JSON / tags; callers map that to an
 * error outcome.
 */
export function decodeSandboxResult(text: string): unknown {
  return decodeSandboxNode(JSON.parse(text));
}

function encodeSandboxNumber(value: number): unknown {
  if (Number.isFinite(value) && !Object.is(value, -0)) {
    return value;
  }
  let token = "-0";
  if (Number.isNaN(value)) {
    token = "NaN";
  } else if (value === Number.POSITIVE_INFINITY) {
    token = "Inf";
  } else if (value === Number.NEGATIVE_INFINITY) {
    token = "-Inf";
  }
  return { [SANDBOX_RESULT_TAG]: "num", v: token };
}

function encodeSandboxMap(
  value: Map<unknown, unknown>,
  seen: Set<unknown>
): unknown {
  const entries: [unknown, unknown][] = [];
  for (const [k, v] of value) {
    entries.push([encodeSandboxNode(k, seen), encodeSandboxNode(v, seen)]);
  }
  return { [SANDBOX_RESULT_TAG]: "map", v: entries };
}

function encodeSandboxSet(value: Set<unknown>, seen: Set<unknown>): unknown {
  const items: unknown[] = [];
  for (const item of value) {
    items.push(encodeSandboxNode(item, seen));
  }
  return { [SANDBOX_RESULT_TAG]: "set", v: items };
}

function encodeSandboxView(value: ArrayBufferView): unknown {
  // Mirror the inline encodeResult's falsy check: a missing or empty
  // constructor name falls back to Uint8Array.
  const ctorName = value.constructor?.name;
  const kind =
    ctorName === undefined || ctorName === "" ? "Uint8Array" : ctorName;
  return {
    [SANDBOX_RESULT_TAG]: "bytes",
    k: kind,
    v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
      "base64"
    ),
  };
}

function encodeSandboxPlainObject(
  value: Record<string, unknown>,
  seen: Set<unknown>
): unknown {
  const out: Record<string, unknown> = {};
  let hasTagKey = false;
  for (const key of Object.keys(value)) {
    if (key === SANDBOX_RESULT_TAG) {
      hasTagKey = true;
    }
    const encoded = encodeSandboxNode(value[key], seen);
    if (key === "__proto__") {
      // Only "__proto__" needs defineProperty: a plain `out[key] =` invokes the
      // prototype setter and silently drops it (decodeSandboxObject preserves it
      // as a data property, so dropping would break the round-trip). Every other
      // key uses cheap assignment.
      Object.defineProperty(out, key, {
        value: encoded,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      out[key] = encoded;
    }
  }
  // Escape a plain object that literally carries a "$" key so the parent does
  // not mistake it for a type tag.
  return hasTagKey ? { [SANDBOX_RESULT_TAG]: "obj", v: out } : out;
}

function encodeSandboxComposite(value: object, seen: Set<unknown>): unknown {
  if (Array.isArray(value)) {
    // for...of yields `undefined` for holes (Array.prototype.map SKIPS them and
    // JSON would render them as null), matching the inline encoder so a sparse
    // array round-trips identically through both codecs.
    const arr: unknown[] = [];
    for (const item of value) {
      arr.push(encodeSandboxNode(item, seen));
    }
    return arr;
  }
  if (value instanceof Date) {
    return { [SANDBOX_RESULT_TAG]: "date", v: value.getTime() };
  }
  if (value instanceof RegExp) {
    return {
      [SANDBOX_RESULT_TAG]: "regexp",
      src: value.source,
      flags: value.flags,
    };
  }
  if (value instanceof Map) {
    return encodeSandboxMap(value, seen);
  }
  if (value instanceof Set) {
    return encodeSandboxSet(value, seen);
  }
  if (value instanceof ArrayBuffer) {
    return {
      [SANDBOX_RESULT_TAG]: "bytes",
      k: "ArrayBuffer",
      v: Buffer.from(value).toString("base64"),
    };
  }
  if (ArrayBuffer.isView(value)) {
    return encodeSandboxView(value);
  }
  return encodeSandboxPlainObject(value as Record<string, unknown>, seen);
}

function encodeSandboxNode(value: unknown, seen: Set<unknown>): unknown {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return { [SANDBOX_RESULT_TAG]: "undef" };
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return encodeSandboxNumber(value);
  }
  if (typeof value === "bigint") {
    return { [SANDBOX_RESULT_TAG]: "bigint", v: value.toString() };
  }
  if (typeof value === "function" || typeof value === "symbol") {
    // Bare reason; the caller (writeRunResult / writeResult) adds the
    // "Result is not serializable: " prefix so the message is not doubled.
    throw new Error(typeof value);
  }
  if (seen.has(value)) {
    throw new Error("circular reference");
  }
  seen.add(value);
  try {
    return encodeSandboxComposite(value, seen);
  } finally {
    seen.delete(value);
  }
}

/**
 * Encode an arbitrary value as the tagged-JSON wire form `decodeSandboxResult`
 * reads back; the exact inverse of `decodeSandboxNode`. Used by the standalone
 * sandbox server to put a result on the HTTP response (the in-pod grandchild
 * uses the inline `encodeResult` instead, since it cannot import this module).
 *
 * keep in lockstep with decodeSandboxNode and the inline encodeResult in
 * SANDBOX_CHILD_SOURCE: the three share one tag scheme ("$"-keyed envelopes for
 * undefined, non-finite/-0 numbers, bigint, Date, RegExp, Map, Set, byte views,
 * and "$"-collision escaping). Throws on a value with no safe representation
 * (function, symbol, or a circular reference), mirroring the inline encodeResult.
 */
export function encodeSandboxResult(value: unknown): string {
  return JSON.stringify(encodeSandboxNode(value, new Set<unknown>()));
}

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
 *   - Write a length-prefixed, tagged-JSON outcome to the dedicated
 *     result pipe (fd SANDBOX_RESULT_FD), leaving stdout user-facing
 */
export const SANDBOX_CHILD_SOURCE = `
"use strict";
const { createContext, runInContext } = require("node:vm");
const fs = require("node:fs");
const dnsPromises = require("node:dns").promises;
const { BlockList, isIP } = require("node:net");

// Captured BEFORE any user code runs so the result frame is written through a
// reference a sandbox escape cannot monkeypatch. The genuine result therefore
// reaches fd ${SANDBOX_RESULT_FD} first even if escaped user code reassigns
// fs.writeSync / process.exit; the parent's first-frame-wins read then ignores
// any later forged frame (F-010).
const RESULT_FD = ${SANDBOX_RESULT_FD};
const RESULT_HEADER_BYTES = ${SANDBOX_RESULT_HEADER_BYTES};
const __writeSync = fs.writeSync.bind(fs);
const __exit = process.exit.bind(process);

const MAX_LOG_ENTRIES = 200;

// Cap on redirect hops a single sandboxed fetch will follow before giving
// up, mirroring undici's built-in maxRedirections default.
const MAX_SANDBOX_REDIRECTS = 20;

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
// Redirects: lacking the per-connect hook, the wrapped fetch uses
// redirect:"manual" and re-runs these same checks on each 3xx Location
// before following it, so a redirect cannot chase a public host into a
// blocked one (IMDS, K8s apiserver, *.svc.cluster.local).
// Testing note: the sandbox guard is not unit-tested directly because
// this entire file is a template literal executed in a subprocess via
// "node -e". The parallel behavior in lib/safe-fetch.ts is unit-tested
// (tests/unit/safe-fetch.test.ts) and these CIDR / hostname denylists
// are kept in lockstep with that file by convention.
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
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
const SSRF_IPV4_CIDRS = ${JSON.stringify(blocklist.ipv4Cidrs)};
const SSRF_IPV4_BROADCAST_ADDRESSES = ${JSON.stringify(blocklist.ipv4BroadcastAddresses)};
const SSRF_IPV6_LITERAL_ADDRESSES = ${JSON.stringify(blocklist.ipv6LiteralAddresses)};
const SSRF_IPV6_CIDRS = ${JSON.stringify(blocklist.ipv6Cidrs)};
const SSRF_NAT64_PREFIX_CIDR = ${JSON.stringify(blocklist.nat64PrefixCidr)};

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

// Rewrite the method/body for the next hop the way undici's follow mode
// would: 301/302 downgrade a POST to GET, 303 downgrades any non-GET/HEAD
// to GET, and 307/308 preserve both. Keeps manual redirect following
// behaviourally equivalent to the network layer's own follow.
function applyRedirectMethod(init, status) {
  const next = Object.assign({}, init);
  const method = (typeof next.method === "string" ? next.method : "GET").toUpperCase();
  const downgrade =
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "GET" && method !== "HEAD");
  if (downgrade) {
    next.method = "GET";
    delete next.body;
  }
  return next;
}

// Pre-DNS hostname denylist interpolated from lib/ssrf-blocklist.ts at
// module-render time. See that module for the rationale (case handling,
// suffix semantics, cluster-domain assumption).
const BLOCKED_HOST_EXACT = new Set(${JSON.stringify(blocklist.blockedHostExact)});
const BLOCKED_HOST_SUFFIXES = ${JSON.stringify(blocklist.blockedHostSuffixes)};

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

    // Follow redirects manually so every hop is re-validated. undici's
    // built-in follow mode would transparently chase a 3xx Location into a
    // blocked host (IMDS, K8s apiserver, *.svc.cluster.local) because the
    // SSRF guard above only sees the initial URL. "manual" returns the real
    // 3xx response with a readable Location header, so we re-run the same
    // scheme + SSRF checks before issuing the next request.
    const baseInit = Object.assign({}, init, {
      signal: controller.signal,
      redirect: "manual",
    });

    let currentResource = resource;
    let currentBase = parsed;
    let currentInit = baseInit;
    let redirectsLeft = MAX_SANDBOX_REDIRECTS;

    try {
      while (true) {
        const response = await fetch(currentResource, currentInit);
        const location = REDIRECT_STATUSES.has(response.status)
          ? response.headers.get("location")
          : null;
        if (location === null) {
          return response;
        }
        if (redirectsLeft <= 0) {
          throw new Error("sandbox fetch: too many redirects");
        }
        redirectsLeft -= 1;

        let nextUrl;
        try {
          nextUrl = new URL(location, currentBase);
        } catch (_e) {
          throw new Error("sandbox fetch: invalid redirect location: " + location);
        }
        if (!ALLOWED_SCHEMES.has(nextUrl.protocol)) {
          throw new Error("sandbox fetch: scheme not allowed: " + nextUrl.protocol);
        }
        const nextHostname = stripIpv6Brackets(nextUrl.hostname);
        const nextCheck = await checkHostnameSsrf(nextHostname);
        if (nextCheck.blocked) {
          const nextIp = nextCheck.ip;
          const nextSuffix = nextIp && nextIp !== nextHostname ? " -> " + nextIp : "";
          throw new Error(
            "sandbox fetch: SSRF blocked (" + nextHostname + nextSuffix + ")"
          );
        }

        // Discard the redirect body so the underlying socket is freed.
        if (response.body) {
          try {
            await response.body.cancel();
          } catch (_e) {
            // body may already be consumed or unsupported; ignore
          }
        }

        currentInit = applyRedirectMethod(currentInit, response.status);
        currentResource = nextUrl.href;
        currentBase = nextUrl;
      }
    } finally {
      clearTimeout(timer);
    }
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

// Encode an outcome as tagged JSON. The PARENT recovers it with JSON.parse
// (safe on untrusted input) plus decodeSandboxResult(), so it never runs
// v8.deserialize on bytes a sandbox escape could control. Mirrors
// decodeSandboxNode in this module exactly; keep the two in lockstep.
// Throws on a value with no safe representation (function, symbol, cycle),
// which writeResult maps to a structured "not serializable" outcome.
function encodeResult(value, seen) {
  if (value === null) {
    return null;
  }
  const t = typeof value;
  if (t === "undefined") {
    return { "$": "undef" };
  }
  if (t === "boolean" || t === "string") {
    return value;
  }
  if (t === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) {
      return value;
    }
    let token = "-0";
    if (Number.isNaN(value)) {
      token = "NaN";
    } else if (value === Infinity) {
      token = "Inf";
    } else if (value === -Infinity) {
      token = "-Inf";
    }
    return { "$": "num", "v": token };
  }
  if (t === "bigint") {
    return { "$": "bigint", "v": value.toString() };
  }
  if (t === "function" || t === "symbol") {
    // Bare reason; writeResult's catch adds the "Result is not serializable: "
    // prefix so the message is not doubled.
    throw new Error(t);
  }
  if (seen.has(value)) {
    throw new Error("circular reference");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const arr = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        arr[i] = encodeResult(value[i], seen);
      }
      return arr;
    }
    if (value instanceof Date) {
      return { "$": "date", "v": value.getTime() };
    }
    if (value instanceof RegExp) {
      return { "$": "regexp", "src": value.source, "flags": value.flags };
    }
    if (value instanceof Map) {
      const entries = [];
      for (const pair of value) {
        entries.push([encodeResult(pair[0], seen), encodeResult(pair[1], seen)]);
      }
      return { "$": "map", "v": entries };
    }
    if (value instanceof Set) {
      const items = [];
      for (const item of value) {
        items.push(encodeResult(item, seen));
      }
      return { "$": "set", "v": items };
    }
    if (value instanceof ArrayBuffer) {
      return {
        "$": "bytes",
        "k": "ArrayBuffer",
        "v": Buffer.from(value).toString("base64"),
      };
    }
    if (ArrayBuffer.isView(value)) {
      const kind =
        value.constructor && value.constructor.name
          ? value.constructor.name
          : "Uint8Array";
      return {
        "$": "bytes",
        "k": kind,
        "v": Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
          "base64"
        ),
      };
    }
    const out = {};
    let hasTagKey = false;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === "$") {
        hasTagKey = true;
      }
      const encoded = encodeResult(value[key], seen);
      if (key === "__proto__") {
        // Only "__proto__" needs defineProperty (a plain assignment invokes the
        // prototype setter and drops it); every other key uses cheap assignment.
        Object.defineProperty(out, key, {
          value: encoded,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        out[key] = encoded;
      }
    }
    // Escape a user object that literally carries a "$" key so the parent does
    // not mistake it for a type tag.
    return hasTagKey ? { "$": "obj", "v": out } : out;
  } finally {
    seen.delete(value);
  }
}

function writeResult(message) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(encodeResult(message, new Set())), "utf8");
  } catch (cloneErr) {
    payload = Buffer.from(
      JSON.stringify(
        encodeResult(
          {
            ok: false,
            errorMessage:
              "Result is not serializable: " +
              (cloneErr && cloneErr.message
                ? cloneErr.message
                : String(cloneErr)),
            errorStack: undefined,
            logs: [],
          },
          new Set()
        )
      ),
      "utf8"
    );
  }
  // F-010: emit the result as a single length-prefixed frame on the dedicated
  // result pipe (fd RESULT_FD), NOT on stdout. The 4-byte big-endian length
  // lets the parent read exactly one frame and ignore anything appended after
  // it, and stdout stays purely user-facing (never deserialized). Use the
  // startup-captured __writeSync so escaped user code that reassigned
  // fs.writeSync cannot suppress the genuine frame.
  const header = Buffer.allocUnsafe(RESULT_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  const out = Buffer.concat([header, payload]);
  let written = 0;
  while (written < out.length) {
    try {
      written += __writeSync(RESULT_FD, out, written, out.length - written);
    } catch (writeErr) {
      if (writeErr && writeErr.code === "EAGAIN") {
        continue;
      }
      break;
    }
  }
  // Hard-exit through the captured reference so a lingering escaped child that
  // reassigned process.exit is still reaped promptly. Correctness does not
  // depend on this: the parent already took the first frame above.
  __exit(0);
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
