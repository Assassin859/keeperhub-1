import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deserialize } from "node:v8";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SANDBOX_CHILD_SOURCE,
  SANDBOX_RESULT_SENTINEL,
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

function parseChildOutput(stdout: string): SandboxOutcome {
  const idx = stdout.lastIndexOf(SANDBOX_RESULT_SENTINEL);
  if (idx === -1) {
    return { ok: false, errorMessage: "no sentinel in stdout", logs: [] };
  }
  const newlineIdx = stdout.indexOf("\n", idx);
  const end = newlineIdx === -1 ? stdout.length : newlineIdx;
  const base64 = stdout.slice(idx + SANDBOX_RESULT_SENTINEL.length, end).trim();
  try {
    return deserialize(Buffer.from(base64, "base64")) as SandboxOutcome;
  } catch (_err) {
    return { ok: false, errorMessage: "malformed v8 payload", logs: [] };
  }
}

async function runSandboxed(
  userCode: string,
  timeoutMs = 3000,
  source: string = SANDBOX_CHILD_SOURCE
): Promise<SandboxOutcome> {
  return await new Promise<SandboxOutcome>((resolve) => {
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
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

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (err: Error) => {
      finish({ ok: false, errorMessage: err.message, logs: [] });
    });
    child.on("close", () => {
      finish(parseChildOutput(stdout));
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

// F-010 mitigation: the grandchild must flush its result via a synchronous
// fd-1 write and then process.exit(0) immediately, so a post-escape
// user-scheduled stdout write cannot emit a second, later sentinel that the
// parent's lastIndexOf() would otherwise select as the authoritative result.
describe("sandbox grandchild flushes the result then hard-exits", () => {
  it("writeResult writes the result synchronously and then hard-exits", () => {
    expect(SANDBOX_CHILD_SOURCE).toContain("fs.writeSync(1");
    expect(SANDBOX_CHILD_SOURCE).toContain("process.exit(0)");
  });

  it("keeps the real result even when escaped code schedules a post-result stdout write", async () => {
    // Reach the host process via the canonical escape (proven reachable by
    // sandbox/src/run-code.test.ts), reach the host global for a real timer,
    // and schedule a forged sentinel for AFTER the real result. With
    // process.exit(0) in writeResult the child dies first, so the forged bytes
    // never reach the parent and lastIndexOf() selects the real result. The
    // primitives are wrapped in try/catch so the test is never flaky if one is
    // unavailable; it then simply returns the real result.
    const code = [
      "try {",
      '  const proc = Error.constructor("return process")();',
      '  const g = proc.constructor.constructor("return globalThis")();',
      '  g.setTimeout(function(){ try { proc.stdout.write("\\u0001RESULT\\u0002////\\n"); } catch (e) {} }, 5);',
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
