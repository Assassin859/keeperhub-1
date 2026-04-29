/**
 * Sandbox Escape-Matrix E2E suite (Phase 38).
 *
 * Proves that the three known exfil paths + two defence-in-depth paths
 * are closed when SANDBOX_BACKEND=remote. Runs against a deployed
 * KeeperHub environment via the public workflow-execution REST API so
 * the test exercises the full selector -> sandbox-client -> sandbox
 * service stack exactly as a production user workflow would.
 *
 * Prerequisites (see tests/e2e/sandbox-escape/README.md):
 *   STAGING_URL=https://staging.keeperhub.com (or http://localhost:3000 for minikube)
 *   STAGING_API_TOKEN=<workflow-creation + execution scope>
 *   EXPECTED_SENTINEL=<sentinel planted in main-app env for this test run>
 *
 * Skips cleanly if any of the three env vars are missing so unit/CI runs
 * that don't have staging wiring don't fail.
 */
import { describe, expect, it } from "vitest";

const STAGING_URL = process.env.STAGING_URL ?? "";
const STAGING_API_TOKEN = process.env.STAGING_API_TOKEN ?? "";
const EXPECTED_SENTINEL = process.env.EXPECTED_SENTINEL ?? "";

const SHOULD_RUN =
  STAGING_URL !== "" &&
  STAGING_API_TOKEN !== "" &&
  EXPECTED_SENTINEL !== "";

// Small helper wrapping the platform's synchronous code-execution API.
// Endpoint shape matches lib/api/execute/ — exact path to be confirmed
// against the deployed route table (the API surface is stable but the
// concrete URL differs between v1.7 direct-execution and v1.9 workflow
// listing paths).
type RunCodeApiResponse = {
  success: boolean;
  result?: unknown;
  error?: string;
  logs?: Array<{ level: string; args: unknown[] }>;
  line?: number;
};

async function runUserCodeAgainstRemoteSandbox(
  code: string,
): Promise<RunCodeApiResponse> {
  const url = `${STAGING_URL}/api/v1/execute/run-code`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${STAGING_API_TOKEN}`,
    },
    body: JSON.stringify({ code, timeout: 10 }),
  });
  if (!res.ok) {
    throw new Error(`run-code API returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as RunCodeApiResponse;
}

function assertNoSentinel(payload: string): void {
  expect(payload).not.toContain(EXPECTED_SENTINEL);
}

describe.skipIf(!SHOULD_RUN)("Sandbox Escape Matrix (Phase 38 E2E)", () => {
  it("TEST-01: Error.constructor escape cannot read CHILD_ENV_ALLOWLIST-external vars", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `const p = Error.constructor("return process")();
       return JSON.stringify({ keys: Object.keys(p.env), snap: p.env });`,
    );
    expect(outcome.success).toBe(true);
    const serialized = JSON.stringify(outcome.result ?? {});
    assertNoSentinel(serialized);
  });

  it("TEST-02: /proc/self/environ inside sandbox does not contain main-pod secret", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `try {
         const p = Error.constructor("return process")();
         const fs = p.mainModule.require("fs");
         return fs.readFileSync("/proc/self/environ", "utf8");
       } catch (e) { return "READ_FAILED: " + (e && e.message ? e.message : String(e)); }`,
    );
    expect(outcome.success).toBe(true);
    assertNoSentinel(String(outcome.result ?? ""));
  });

  it("TEST-03: /proc/1/environ and /proc/<ppid>/environ do not reveal main-pod secrets", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `try {
         const p = Error.constructor("return process")();
         const fs = p.mainModule.require("fs");
         const pid1 = (() => { try { return fs.readFileSync("/proc/1/environ", "utf8"); } catch (e) { return "ENOENT_OR_FAIL"; } })();
         const ppid = (() => { try { return fs.readFileSync("/proc/" + p.ppid + "/environ", "utf8"); } catch (e) { return "ENOENT_OR_FAIL"; } })();
         return { pid1, ppid };
       } catch (e) { return { pid1: "OUTER_FAIL", ppid: "OUTER_FAIL" }; }`,
    );
    expect(outcome.success).toBe(true);
    const payload = JSON.stringify(outcome.result ?? {});
    assertNoSentinel(payload);
  });

  it("TEST-04: /var/run/secrets/kubernetes.io/serviceaccount/token is ENOENT", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `try {
         const p = Error.constructor("return process")();
         const fs = p.mainModule.require("fs");
         return fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
       } catch (e) { return "READ_FAILED: " + (e && e.code ? e.code : (e && e.message ? e.message : String(e))); }`,
    );
    expect(outcome.success).toBe(true);
    const result = String(outcome.result ?? "");
    expect(result).toMatch(/READ_FAILED:\s*(ENOENT|no such file)/i);
    assertNoSentinel(result);
  });

  it("TEST-05: /var/run/secrets/eks.amazonaws.com/serviceaccount/token is ENOENT", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `try {
         const p = Error.constructor("return process")();
         const fs = p.mainModule.require("fs");
         return fs.readFileSync("/var/run/secrets/eks.amazonaws.com/serviceaccount/token", "utf8");
       } catch (e) { return "READ_FAILED: " + (e && e.code ? e.code : (e && e.message ? e.message : String(e))); }`,
    );
    expect(outcome.success).toBe(true);
    const result = String(outcome.result ?? "");
    expect(result).toMatch(/READ_FAILED:\s*(ENOENT|no such file)/i);
    assertNoSentinel(result);
  });
});

// Fallback describe block surfaces a clear message in local / CI runs that
// don't have staging wiring, instead of the suite being silently empty.
describe.skipIf(SHOULD_RUN)(
  "Sandbox Escape Matrix (Phase 38 E2E) — skipped (set STAGING_URL, STAGING_API_TOKEN, EXPECTED_SENTINEL)",
  () => {
    it("is skipped because required env vars are not set", () => {
      expect(SHOULD_RUN).toBe(false);
    });
  },
);
