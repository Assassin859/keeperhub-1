import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deserialize, serialize } from "node:v8";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createSandboxResultReader,
  decodeSandboxResult,
  encodeSandboxResult,
  SANDBOX_CHILD_SOURCE,
  SANDBOX_RESULT_FD,
  SANDBOX_RESULT_MAX_BYTES,
} from "@/lib/sandbox/child-source";
import {
  SSRF_BLOCKED_HOST_EXACT,
  SSRF_BLOCKED_HOST_SUFFIXES,
  SSRF_IPV4_BROADCAST_ADDRESSES,
  SSRF_IPV4_CIDRS,
  SSRF_IPV6_CIDRS,
  SSRF_IPV6_LITERAL_ADDRESSES,
  SSRF_NAT64_PREFIX_CIDR,
} from "@/lib/ssrf-blocklist";

// The sandbox grandchild runs as a separate `node -e <SANDBOX_CHILD_SOURCE>`
// subprocess with no access to npm or the rest of the codebase, so the SSRF
// blocklist has to cross the process boundary as inlined literals
// (`JSON.stringify` interpolation at template-render time). This file locks
// two contracts:
//   1. Data parity: every entry in lib/ssrf-blocklist.ts must appear in the
//      rendered source.
//   2. Behavioural parity: the rendered source actually blocks the things
//      it inlines when spawned and asked to fetch them. Item #2 is the
//      contract the KEEP-603 incident required and the contract data-only
//      tests cannot prove on their own.
describe("sandbox child-source consumes lib/ssrf-blocklist.ts", () => {
  it("inlines every IPv4 CIDR tuple from the SoT", () => {
    for (const cidr of SSRF_IPV4_CIDRS) {
      expect(SANDBOX_CHILD_SOURCE).toContain(JSON.stringify(cidr));
    }
  });

  it("inlines every IPv4 broadcast address from the SoT", () => {
    for (const addr of SSRF_IPV4_BROADCAST_ADDRESSES) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${addr}"`);
    }
  });

  it("inlines every IPv6 CIDR tuple from the SoT", () => {
    for (const cidr of SSRF_IPV6_CIDRS) {
      expect(SANDBOX_CHILD_SOURCE).toContain(JSON.stringify(cidr));
    }
  });

  it("inlines every IPv6 literal address from the SoT", () => {
    for (const addr of SSRF_IPV6_LITERAL_ADDRESSES) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${addr}"`);
    }
  });

  it("inlines the NAT64 well-known prefix tuple from the SoT", () => {
    expect(SANDBOX_CHILD_SOURCE).toContain(
      JSON.stringify(SSRF_NAT64_PREFIX_CIDR)
    );
  });

  it("inlines every blocked-host exact match from the SoT", () => {
    for (const host of SSRF_BLOCKED_HOST_EXACT) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${host}"`);
    }
  });

  it("inlines every blocked-host suffix from the SoT", () => {
    for (const suffix of SSRF_BLOCKED_HOST_SUFFIXES) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${suffix}"`);
    }
  });

  it("renders syntactically valid JavaScript", async () => {
    // `node -e` parses the source at process start. If the template literal
    // ever produces invalid JS (e.g. an interpolation breaks a string
    // boundary or yields a reserved-word identifier), every Code-node
    // workflow run would crash at startup. Use Node's vm.Script to do a
    // parse-only check without executing anything.
    const { Script } = await import("node:vm");
    expect(() => new Script(SANDBOX_CHILD_SOURCE)).not.toThrow();
  });
});

// Drift-resistance policy guard. The grandchild template is now
// data-imported from lib/ssrf-blocklist.json; any other import would either
// silently no-op in the spawned subprocess (runtime values do not propagate
// across "node -e") or introduce a dependency the standalone sandbox image
// does not have. Lock the contract here so it cannot regress quietly.
const IMPORT_STATEMENT_REGEX = /^import\s.+$/gm;
const SCHEME_NOT_ALLOWED_REGEX = /scheme not allowed/;
const TOO_MANY_REDIRECTS_REGEX = /too many redirects/;

describe("lib/sandbox/child-source.ts only imports pure data", () => {
  it("has at most one import and it points at the SSRF blocklist JSON", async () => {
    const src = await readFile("lib/sandbox/child-source.ts", "utf8");
    const imports = src.match(IMPORT_STATEMENT_REGEX) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain('"../ssrf-blocklist.json"');
    expect(imports[0]).toContain('with { type: "json" }');
  });
});

type SandboxOutcome =
  | { ok: true; result: unknown; logs: unknown[] }
  | {
      ok: false;
      errorMessage: string;
      errorStack?: string;
      logs: unknown[];
    };

function outcomeFromReader(
  reader: ReturnType<typeof createSandboxResultReader>
): SandboxOutcome {
  if (reader.error) {
    return { ok: false, errorMessage: reader.error, logs: [] };
  }
  if (!reader.frame) {
    return { ok: false, errorMessage: "no result frame on fd 3", logs: [] };
  }
  try {
    return decodeSandboxResult(reader.frame.toString("utf8")) as SandboxOutcome;
  } catch (_err) {
    return { ok: false, errorMessage: "malformed result payload", logs: [] };
  }
}

// Mirrors the production parent (sandbox/src/run-code.ts): spawn with the
// dedicated fd-3 result channel, read the first length-prefixed frame, and
// never deserialize stdout.
async function runSandboxed(
  userCode: string,
  timeoutMs = 3000,
  source: string = SANDBOX_CHILD_SOURCE
): Promise<SandboxOutcome> {
  return await new Promise<SandboxOutcome>((resolve) => {
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const reader = createSandboxResultReader();
    let settled = false;

    function finish(outcome: SandboxOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch (_err) {
          // child may already have exited
        }
      }
      resolve(outcome);
    }

    const killTimer = setTimeout(() => {
      finish({ ok: false, errorMessage: "harness timeout", logs: [] });
    }, timeoutMs + 3000);

    child.stdout.resume();
    child.stderr.resume();
    const resultStream = child.stdio[SANDBOX_RESULT_FD];
    if (resultStream && "on" in resultStream) {
      resultStream.on("data", (chunk: Buffer) => {
        reader.push(chunk);
        if (reader.done) {
          finish(outcomeFromReader(reader));
        }
      });
    }
    child.on("error", (err: Error) => {
      finish({ ok: false, errorMessage: err.message, logs: [] });
    });
    child.on("close", () => {
      finish(outcomeFromReader(reader));
    });

    try {
      child.stdin.write(JSON.stringify({ code: userCode, timeoutMs }));
      child.stdin.end();
    } catch (err) {
      finish({
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        logs: [],
      });
    }
  });
}

function expectBlocked(outcome: SandboxOutcome): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    return;
  }
  expect(outcome.errorMessage).toMatch(/SSRF blocked/);
}

// Behavioural parity: spawn the actual grandchild and confirm the SSRF
// guard fires for every category Sasha listed in the incident response
// (RFC 1918, link-local incl. IMDSv2, multicast, reserved, IPv6 transition
// prefixes, and the pre-DNS hostname denylist). These cases use IP
// literals or pre-DNS-blocked hostnames so the test is deterministic and
// performs no real DNS / network IO.
describe("sandbox grandchild SSRF guard fires on every category", () => {
  it.each([
    ['await fetch("http://169.254.169.254/")', "IMDSv2 link-local"],
    ['await fetch("http://10.0.0.1/")', "RFC 1918"],
    ['await fetch("http://127.0.0.1/")', "loopback IPv4"],
    ['await fetch("http://255.255.255.255/")', "IPv4 broadcast"],
    ['await fetch("http://[::1]/")', "IPv6 loopback"],
    ['await fetch("http://[fc00::1]/")', "ULA IPv6"],
    ['await fetch("http://[fe80::1]/")', "link-local IPv6"],
    ['await fetch("http://[2001::1]/")', "Teredo (2001::/32)"],
    ['await fetch("http://[2002::1]/")', "6to4 (2002::/16)"],
    [
      'await fetch("http://[2001:db8::1]/")',
      "documentation range (2001:db8::/32)",
    ],
    [
      'await fetch("http://[64:ff9b:1::1]/")',
      "site-local NAT64 (64:ff9b:1::/48)",
    ],
    ['await fetch("http://[ff02::1]/")', "multicast IPv6"],
  ])("blocks %s (%s)", async (snippet) => {
    const outcome = await runSandboxed(snippet);
    expectBlocked(outcome);
  });

  it.each([
    ['await fetch("http://localhost/")', "pre-DNS exact match"],
    ['await fetch("http://LOCALHOST/")', "case normalisation"],
    ['await fetch("http://localhost./")', "trailing-dot normalisation"],
    ['await fetch("http://probe.svc.cluster.local/")', "*.svc.cluster.local"],
    ['await fetch("http://probe.pod.cluster.local/")', "*.pod.cluster.local"],
    ['await fetch("http://probe.internal/")', "*.internal"],
    ['await fetch("http://probe.local/")', "*.local (mDNS / Bonjour)"],
  ])("blocks %s before DNS (%s)", async (snippet) => {
    const outcome = await runSandboxed(snippet);
    expectBlocked(outcome);
  });
}, 30_000);

// Structural guard for the redirect re-validation wiring. undici's default
// follow mode would chase a 3xx Location into a blocked host because the
// SSRF guard only sees the initial URL; the wrapped fetch must instead use
// manual redirects and re-check every hop. Lock the key tokens so the
// behaviour cannot regress silently if the template is refactored.
describe("sandbox grandchild re-validates redirects", () => {
  it("uses manual redirect mode on the wrapped fetch", () => {
    expect(SANDBOX_CHILD_SOURCE).toContain('redirect: "manual"');
  });

  it("re-runs the SSRF check on each redirect hop and caps the chain", () => {
    expect(SANDBOX_CHILD_SOURCE).toContain("REDIRECT_STATUSES");
    expect(SANDBOX_CHILD_SOURCE).toContain("MAX_SANDBOX_REDIRECTS");
    expect(SANDBOX_CHILD_SOURCE).toContain("too many redirects");
  });
});

// Behavioural coverage for the redirect loop. The real grandchild blocks
// every locally-bindable address, so no hop of a local test server would be
// reachable. We derive a variant of the real source with only the IPv4
// loopback subnet removed, leaving link-local/IMDS (169.254.0.0/16), RFC1918
// and the cluster-hostname denylist intact - exactly the redirect targets
// the per-hop re-validation must still catch. The redirect-following code
// under test is otherwise the unmodified production source.
const LOOPBACK_CIDR_TUPLE = '["127.0.0.0",8]';
const REDIRECT_TEST_SOURCE = SANDBOX_CHILD_SOURCE.replace(
  `,${LOOPBACK_CIDR_TUPLE}`,
  ""
);

type FetchResult = { status: number; body: string };

function resultOf(outcome: SandboxOutcome): FetchResult {
  if (!outcome.ok) {
    throw new Error(`expected ok outcome, got: ${outcome.errorMessage}`);
  }
  return outcome.result as FetchResult;
}

// Each redirect route maps to a server-defined target. The Location is
// never derived from the request (which CodeQL would flag as an open
// redirect); the test picks behaviour by choosing a path, and the server
// reflects a fixed, server-owned target for that path.
type RedirectRoute = { status: number; location: string };

describe("sandbox grandchild redirect following", () => {
  let server: Server;
  let base: string;
  let routes: Record<string, RedirectRoute> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = routes[url.pathname];
      if (route) {
        res.writeHead(route.status, { Location: route.location });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`FINAL method=${req.method} body=${body}`);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    routes = {
      "/r/ok": { status: 302, location: `${base}/ok` },
      "/r/ok307": { status: 307, location: `${base}/ok` },
      "/r/chain": { status: 302, location: `${base}/r/ok` },
      "/r/imds": {
        status: 302,
        location: "http://169.254.169.254/latest/meta-data/",
      },
      "/r/cluster": {
        status: 302,
        location: "http://probe.svc.cluster.local/",
      },
      "/r/scheme": { status: 302, location: "file:///etc/passwd" },
      "/loop": { status: 302, location: "/loop" },
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function getCode(url: string): string {
    return `const r = await fetch(${JSON.stringify(url)}); return { status: r.status, body: await r.text() };`;
  }

  function postCode(url: string, body: string): string {
    return `const r = await fetch(${JSON.stringify(url)}, { method: "POST", body: ${JSON.stringify(body)} }); return { status: r.status, body: await r.text() };`;
  }

  it("sanity: the test source actually dropped the loopback block", () => {
    expect(REDIRECT_TEST_SOURCE).not.toBe(SANDBOX_CHILD_SOURCE);
    expect(REDIRECT_TEST_SOURCE).not.toContain(LOOPBACK_CIDR_TUPLE);
  });

  it("follows a 302 to an allowed host", async () => {
    const outcome = await runSandboxed(
      getCode(`${base}/r/ok`),
      3000,
      REDIRECT_TEST_SOURCE
    );
    const result = resultOf(outcome);
    expect(result.status).toBe(200);
    expect(result.body).toContain("FINAL method=GET");
  });

  it("follows a multi-hop redirect chain", async () => {
    const outcome = await runSandboxed(
      getCode(`${base}/r/chain`),
      3000,
      REDIRECT_TEST_SOURCE
    );
    expect(resultOf(outcome).status).toBe(200);
  });

  it("blocks a redirect into IMDS link-local", async () => {
    const outcome = await runSandboxed(
      getCode(`${base}/r/imds`),
      3000,
      REDIRECT_TEST_SOURCE
    );
    expectBlocked(outcome);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("169.254.169.254");
    }
  });

  it("blocks a redirect into a cluster hostname", async () => {
    const outcome = await runSandboxed(
      getCode(`${base}/r/cluster`),
      3000,
      REDIRECT_TEST_SOURCE
    );
    expectBlocked(outcome);
  });

  it("rejects a redirect to a disallowed scheme", async () => {
    const outcome = await runSandboxed(
      getCode(`${base}/r/scheme`),
      3000,
      REDIRECT_TEST_SOURCE
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toMatch(SCHEME_NOT_ALLOWED_REGEX);
    }
  });

  it("downgrades POST to GET and drops the body on a 302", async () => {
    const outcome = await runSandboxed(
      postCode(`${base}/r/ok`, "secret-payload"),
      3000,
      REDIRECT_TEST_SOURCE
    );
    const result = resultOf(outcome);
    expect(result.body).toContain("method=GET");
    expect(result.body).not.toContain("secret-payload");
  });

  it("preserves POST and body across a 307", async () => {
    const outcome = await runSandboxed(
      postCode(`${base}/r/ok307`, "keep-me"),
      3000,
      REDIRECT_TEST_SOURCE
    );
    const result = resultOf(outcome);
    expect(result.body).toContain("method=POST");
    expect(result.body).toContain("keep-me");
  });

  it("errors on an unbounded redirect loop", async () => {
    const outcome = await runSandboxed(
      getCode(`${base}/loop`),
      5000,
      REDIRECT_TEST_SOURCE
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toMatch(TOO_MANY_REDIRECTS_REGEX);
    }
  });
}, 30_000);

// Helper: a forged result frame an escaped child could write to fd 3 — a
// 4-byte big-endian length prefix followed by a v8-serialized success outcome
// carrying an attacker-chosen result. Used by the forgery tests below to prove
// the parent's first-frame-wins read rejects it.
function forgedFrameLiteral(result: string): string {
  const payload = serialize({ ok: true, result, logs: [] });
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  const bytes = [...header, ...payload].join(",");
  return `Buffer.from([${bytes}])`;
}

// F-010 mitigation: the result travels on the dedicated fd-3 channel as a
// length-prefixed frame the parent reads first-frame-wins, and stdout is never
// deserialized. These tests prove a sandbox escape cannot forge a result by
// (a) writing stdout, (b) appending a later fd-3 frame, (c) reassigning
// process.exit, or (d) reassigning fs.writeSync.
describe("sandbox grandchild result channel resists forgery (F-010)", () => {
  it("writes the result frame to the dedicated fd via a captured writeSync, then captured exit", () => {
    expect(SANDBOX_CHILD_SOURCE).toContain("const __writeSync = fs.writeSync");
    expect(SANDBOX_CHILD_SOURCE).toContain("const __exit = process.exit");
    expect(SANDBOX_CHILD_SOURCE).toContain("__writeSync(RESULT_FD");
    expect(SANDBOX_CHILD_SOURCE).toContain("__exit(0)");
    // The result must NOT be written to stdout (fd 1) any more.
    expect(SANDBOX_CHILD_SOURCE).not.toContain("writeSync(1");
  });

  it("ignores a forged sentinel an escape writes to stdout (stdout is never deserialized)", async () => {
    const code = [
      "try {",
      '  const proc = Error.constructor("return process")();',
      '  proc.stdout.write("\\u0001RESULT\\u0002////\\n");',
      "} catch (e) {}",
      'return "REAL";',
    ].join("\n");
    const outcome = await runSandboxed(code, 1500);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe("REAL");
    }
  });

  it("keeps the real result when an escape schedules a LATER forged fd-3 frame", async () => {
    // Reach host require for fs, schedule a forged frame on fd 3 for after the
    // genuine result. The genuine frame is written first, so first-frame-wins
    // discards the forgery.
    const code = [
      "try {",
      '  const req = Error.constructor("return require")();',
      '  const efs = req("node:fs");',
      '  const g = Error.constructor("return globalThis")();',
      `  const forged = ${forgedFrameLiteral("FORGED")};`,
      `  g.setTimeout(function(){ try { efs.writeSync(${SANDBOX_RESULT_FD}, forged); } catch (e) {} }, 5);`,
      "} catch (e) {}",
      'return "REAL";',
    ].join("\n");
    const outcome = await runSandboxed(code, 1500);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe("REAL");
    }
  });

  it("keeps the real result even when the escape disables process.exit before forging", async () => {
    // Disabling process.exit cannot help: correctness rests on first-frame-wins,
    // not on the hard-exit. The genuine frame is still written first.
    const code = [
      "try {",
      '  const proc = Error.constructor("return process")();',
      "  proc.exit = function(){};",
      '  const req = Error.constructor("return require")();',
      '  const efs = req("node:fs");',
      '  const g = Error.constructor("return globalThis")();',
      `  const forged = ${forgedFrameLiteral("FORGED")};`,
      `  g.setTimeout(function(){ try { efs.writeSync(${SANDBOX_RESULT_FD}, forged); } catch (e) {} }, 5);`,
      "} catch (e) {}",
      'return "REAL";',
    ].join("\n");
    const outcome = await runSandboxed(code, 1500);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe("REAL");
    }
  });

  it("keeps the real result even when the escape reassigns fs.writeSync before forging", async () => {
    // The genuine writeResult uses the startup-captured __writeSync, so
    // reassigning fs.writeSync cannot suppress the genuine frame; the later
    // forged frame loses to first-frame-wins.
    const code = [
      "try {",
      '  const req = Error.constructor("return require")();',
      '  const efs = req("node:fs");',
      "  const realWrite = efs.writeSync;",
      "  efs.writeSync = function(){ return 0; };",
      '  const g = Error.constructor("return globalThis")();',
      `  const forged = ${forgedFrameLiteral("FORGED")};`,
      `  g.setTimeout(function(){ try { realWrite(${SANDBOX_RESULT_FD}, forged); } catch (e) {} }, 5);`,
      "} catch (e) {}",
      'return "REAL";',
    ].join("\n");
    const outcome = await runSandboxed(code, 1500);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe("REAL");
    }
  });
});

// Unit coverage for the parent-side frame reader in isolation (no subprocess).
describe("createSandboxResultReader first-frame-wins framing", () => {
  function frame(value: unknown): Buffer {
    const payload = serialize(value);
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
  }

  it("returns the first frame and ignores trailing forged frames", () => {
    const reader = createSandboxResultReader();
    const genuine = frame({ ok: true, result: "REAL", logs: [] });
    const forged = frame({ ok: true, result: "FORGED", logs: [] });
    reader.push(Buffer.concat([genuine, forged]));
    expect(reader.done).toBe(true);
    expect(reader.error).toBeNull();
    expect(reader.frame).not.toBeNull();
    if (reader.frame) {
      expect(deserialize(reader.frame)).toEqual({
        ok: true,
        result: "REAL",
        logs: [],
      });
    }
  });

  it("reassembles a frame delivered across multiple chunks", () => {
    const reader = createSandboxResultReader();
    const buf = frame({ ok: true, result: 42, logs: [] });
    for (const byte of buf) {
      reader.push(Buffer.from([byte]));
    }
    expect(reader.done).toBe(true);
    if (reader.frame) {
      expect(deserialize(reader.frame)).toEqual({
        ok: true,
        result: 42,
        logs: [],
      });
    }
  });

  it("rejects a frame whose declared length exceeds the cap", () => {
    const reader = createSandboxResultReader();
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(SANDBOX_RESULT_MAX_BYTES + 1, 0);
    reader.push(header);
    expect(reader.done).toBe(true);
    expect(reader.frame).toBeNull();
    expect(reader.error).toMatch(/exceeds maximum size/);
  });
});

// End-to-end framing across a real pipe: a result larger than the OS pipe
// buffer (64 KiB on Linux) forces the child's synchronous fd-3 write to span
// multiple drains and the parent's reader to reassemble multiple chunks,
// exercising the EAGAIN-retry/backpressure path the in-memory reader test
// cannot.
describe("sandbox grandchild fd-3 framing survives large multi-chunk results", () => {
  it("round-trips a result larger than the pipe buffer", async () => {
    const outcome = await runSandboxed('return "x".repeat(300000);', 3000);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(typeof outcome.result).toBe("string");
      expect((outcome.result as string).length).toBe(300_000);
    }
  });
});

// The result codec replaces v8.serialize/deserialize so the parent never
// deserializes untrusted v8 (F-010 root cause). It must still preserve the
// structured types the Code node contract promises. These spawn the real
// grandchild and assert fidelity end-to-end through the tagged-JSON channel.
describe("sandbox grandchild result codec preserves structured-type fidelity", () => {
  it("round-trips a nested BigInt (wei-style amounts)", async () => {
    const code =
      "return { amounts: [BigInt(10), BigInt(20)], wei: BigInt('1000000000000000000') };";
    const outcome = await runSandboxed(code);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const r = outcome.result as { amounts: bigint[]; wei: bigint };
      expect(typeof r.amounts[0]).toBe("bigint");
      expect(r.amounts[1]).toBe(BigInt(20));
      expect(r.wei).toBe(BigInt("1000000000000000000"));
    }
  });

  it("round-trips Set and Date", async () => {
    const outcome = await runSandboxed(
      "return { s: new Set([1, 2, 3]), d: new Date(1700000000000) };"
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const r = outcome.result as { s: Set<number>; d: Date };
      expect(r.s).toBeInstanceOf(Set);
      expect([...r.s]).toEqual([1, 2, 3]);
      expect(r.d).toBeInstanceOf(Date);
      expect(r.d.getTime()).toBe(1_700_000_000_000);
    }
  });

  it("round-trips a typed array", async () => {
    const outcome = await runSandboxed("return new Uint8Array([1, 2, 255]);");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBeInstanceOf(Uint8Array);
      expect([...(outcome.result as Uint8Array)]).toEqual([1, 2, 255]);
    }
  });

  it("round-trips NaN / Infinity / undefined", async () => {
    const outcome = await runSandboxed(
      "return { n: NaN, p: Infinity, m: -Infinity, u: undefined };"
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const r = outcome.result as Record<string, unknown>;
      expect(Number.isNaN(r.n)).toBe(true);
      expect(r.p).toBe(Number.POSITIVE_INFINITY);
      expect(r.m).toBe(Number.NEGATIVE_INFINITY);
      expect(r.u).toBeUndefined();
    }
  });

  it("does NOT misinterpret a user object that literally has a \"$\" key", async () => {
    // Collision safety: a user object shaped like a type tag must round-trip as
    // a plain object, not be decoded as a BigInt.
    const outcome = await runSandboxed('return { "$": "bigint", v: "5" };');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toEqual({ $: "bigint", v: "5" });
    }
  });

  it("returns a clean error (not a crash) for a non-serializable value", async () => {
    const outcome = await runSandboxed("return () => 1;");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toMatch(/not serializable/i);
    }
  });

  it("returns a clean error for a circular reference", async () => {
    const outcome = await runSandboxed(
      "const a = {}; a.self = a; return a;"
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toMatch(/serializable|circular/i);
    }
  });
});

// The decoder runs on bytes a sandbox escape can fully control, so it must be
// safe on hostile input in isolation -- no prototype pollution, no v8.
describe("decodeSandboxResult is safe on untrusted input", () => {
  it("does not pollute Object.prototype via a __proto__ key", () => {
    const before = ({} as Record<string, unknown>).polluted;
    const decoded = decodeSandboxResult(
      '{"result":{"__proto__":{"polluted":true}}}'
    ) as { result: Record<string, unknown> };
    // The hostile key lands as an own data property, not on the prototype.
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(Object.getPrototypeOf(decoded.result)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded.result, "__proto__")).toBe(true);
  });

  it("rebuilds tagged values", () => {
    expect(decodeSandboxResult('{"$":"bigint","v":"42"}')).toBe(BigInt(42));
    expect(decodeSandboxResult('{"$":"undef"}')).toBeUndefined();
    const m = decodeSandboxResult('{"$":"map","v":[["a",1]]}') as Map<
      string,
      number
    >;
    expect(m).toBeInstanceOf(Map);
    expect(m.get("a")).toBe(1);
  });

  it("treats an escaped {$:obj} wrapper as a literal object", () => {
    expect(
      decodeSandboxResult('{"$":"obj","v":{"$":"x","y":1}}')
    ).toEqual({ $: "x", y: 1 });
  });

  it("throws on malformed JSON (callers map this to an error outcome)", () => {
    expect(() => decodeSandboxResult("not json")).toThrow();
  });
});

// encodeSandboxResult is the module-scope inverse of decodeSandboxResult used
// by the standalone sandbox server to put a result on the HTTP response. It
// must be a faithful inverse for every type the tag codec supports.
describe("encodeSandboxResult <-> decodeSandboxResult round-trip", () => {
  function roundTrip(value: unknown): unknown {
    return decodeSandboxResult(encodeSandboxResult(value));
  }

  it("round-trips undefined", () => {
    expect(roundTrip(undefined)).toBeUndefined();
  });

  it("round-trips BigInt", () => {
    expect(roundTrip(BigInt("1000000000000000000"))).toBe(
      BigInt("1000000000000000000")
    );
  });

  it("round-trips Date", () => {
    const r = roundTrip(new Date(1_700_000_000_000)) as Date;
    expect(r).toBeInstanceOf(Date);
    expect(r.getTime()).toBe(1_700_000_000_000);
  });

  it("round-trips RegExp", () => {
    const r = roundTrip(/ab+c/gi) as RegExp;
    expect(r).toBeInstanceOf(RegExp);
    expect(r.source).toBe("ab+c");
    expect(r.flags).toBe("gi");
  });

  it("round-trips Map", () => {
    const r = roundTrip(
      new Map<string, number>([
        ["a", 1],
        ["b", 2],
      ])
    ) as Map<string, number>;
    expect(r).toBeInstanceOf(Map);
    expect(r.get("a")).toBe(1);
    expect(r.get("b")).toBe(2);
  });

  it("round-trips Set", () => {
    const r = roundTrip(new Set([1, 2, 3])) as Set<number>;
    expect(r).toBeInstanceOf(Set);
    expect([...r]).toEqual([1, 2, 3]);
  });

  it("round-trips a typed array", () => {
    const r = roundTrip(new Uint8Array([1, 2, 255])) as Uint8Array;
    expect(r).toBeInstanceOf(Uint8Array);
    expect([...r]).toEqual([1, 2, 255]);
  });

  it("round-trips nested objects and arrays", () => {
    const value = { a: [1, { b: BigInt(2) }], c: { d: new Set([9]) } };
    const r = roundTrip(value) as typeof value;
    expect(r.a[0]).toBe(1);
    expect((r.a[1] as { b: bigint }).b).toBe(BigInt(2));
    expect([...(r.c.d as Set<number>)]).toEqual([9]);
  });

  it('round-trips an object literally containing a "$" key', () => {
    expect(roundTrip({ $: "bigint", v: "5" })).toEqual({ $: "bigint", v: "5" });
  });

  it("throws on a function (not serializable)", () => {
    expect(() => encodeSandboxResult(() => 1)).toThrow();
  });
});

// The "bytes" tag carries an attacker-controllable `k` (constructor kind) on an
// UNTRUSTED boundary. The decoder must only ever instantiate real view
// constructors from a fixed allowlist, never resolve an arbitrary global by
// name, and must never throw on a malformed frame.
describe("decodeSandboxResult bytes tag is safe on a forged kind", () => {
  const b64 = (bytes: number[]): string =>
    Buffer.from(bytes).toString("base64");

  it("returns inert Uint8Array bytes for a non-view global kind (e.g. fetch)", () => {
    const r = decodeSandboxResult(
      `{"$":"bytes","k":"fetch","v":"${b64([1, 2, 3])}"}`
    );
    expect(r).toBeInstanceOf(Uint8Array);
    expect([...(r as Uint8Array)]).toEqual([1, 2, 3]);
    expect(typeof r).not.toBe("function");
  });

  it("returns inert Uint8Array bytes for the Function constructor kind", () => {
    const r = decodeSandboxResult(
      `{"$":"bytes","k":"Function","v":"${b64([65])}"}`
    );
    expect(r).toBeInstanceOf(Uint8Array);
    expect(typeof r).not.toBe("function");
  });

  it("does not throw and falls back to raw bytes for a size-mismatched known kind", () => {
    // 5 bytes is not a multiple of Uint32Array's 4-byte element size.
    let decoded: unknown;
    expect(() => {
      decoded = decodeSandboxResult(
        `{"$":"bytes","k":"Uint32Array","v":"${b64([1, 2, 3, 4, 5])}"}`
      );
    }).not.toThrow();
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect([...(decoded as Uint8Array)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("still reconstructs an allowlisted view kind with a valid byte length", () => {
    const r = decodeSandboxResult(
      `{"$":"bytes","k":"Uint16Array","v":"${b64([1, 0, 2, 0])}"}`
    );
    expect(r).toBeInstanceOf(Uint16Array);
    expect([...(r as Uint16Array)]).toEqual([1, 2]);
  });
});
