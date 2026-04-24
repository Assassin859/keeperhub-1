import { describe, expect, it } from "vitest";
import { runCode } from "./run-code.js";

describe("runCode — sandbox child_process runner", () => {
  it("returns a basic arithmetic result with empty logs", async () => {
    const outcome = await runCode({ code: "return 1 + 1;", timeoutMs: 5000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe(2);
      expect(outcome.logs).toEqual([]);
    }
  });

  it("round-trips BigInt via v8 serialization", async () => {
    const outcome = await runCode({
      code: "return BigInt(2) ** BigInt(100);",
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe(2n ** 100n);
      expect(typeof outcome.result).toBe("bigint");
    }
  });

  it("reports a timeout for an infinite loop", async () => {
    const outcome = await runCode({
      code: "while (true) {}",
      timeoutMs: 500,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(
        outcome.errorMessage.toLowerCase().includes("timeout") ||
          outcome.errorMessage.toLowerCase().includes("timed out") ||
          outcome.errorMessage.toLowerCase().includes("script execution") ||
          outcome.errorMessage === "WALL_CLOCK_TIMEOUT"
      ).toBe(true);
    }
  });

  it("scrubs the child environment to the CHILD_ENV_ALLOWLIST only", async () => {
    // Canonical escape payload: Error.constructor("return process")() reaches
    // the host `process` object inside the vm context. Because the child was
    // spawned with execve and a scrubbed env, process.env contains ONLY the
    // allowlist keys.
    const SECRET_KEY = "SANDBOX_TEST_FAKE_SECRET_XYZ";
    const SECRET_VALUE = "leaked-value-must-not-appear";
    process.env[SECRET_KEY] = SECRET_VALUE;

    try {
      const outcome = await runCode({
        code: `const p = Error.constructor("return process")(); return Object.keys(p.env);`,
        timeoutMs: 5000,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        const envKeys = outcome.result as string[];
        // The allowlist is: NODE_ENV, NODE_EXTRA_CA_CERTS, PATH, TZ, LANG, LC_ALL.
        // The fake secret we injected must NOT be present — this is the
        // load-bearing security property. Individual OSes may inject their
        // own system-level vars (e.g. macOS __CF_USER_TEXT_ENCODING); those
        // are harmless and not under CHILD_ENV_ALLOWLIST control.
        expect(envKeys).not.toContain(SECRET_KEY);
        // Every key that IS under our control (from CHILD_ENV_ALLOWLIST)
        // may legitimately appear. Assert no non-allowlisted KeeperHub-style
        // variable leaked (anything matching uppercase APP/SECRET/KEY names).
        const leaked = envKeys.filter((k) =>
          /^(DATABASE|WALLET|STRIPE|GITHUB|GOOGLE|AGENTIC|INTEGRATION|BETTER_AUTH|OAUTH|TURNKEY|CDP|AWS|KUBERNETES)_/i.test(
            k
          )
        );
        expect(leaked).toEqual([]);
      }
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it("blocks fetch() to the AWS IMDS metadata IP (link-local)", async () => {
    const outcome = await runCode({
      code: `return await fetch("http://169.254.169.254/latest/meta-data/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("blocks fetch() to a private IPv4 literal (RFC 1918)", async () => {
    const outcome = await runCode({
      code: `return await fetch("http://10.0.0.1/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("blocks fetch() to loopback IPv4", async () => {
    const outcome = await runCode({
      code: `return await fetch("http://127.0.0.1/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("blocks fetch() to an IPv4-mapped IPv6 literal pointing at private IPv4", async () => {
    const outcome = await runCode({
      code: `return await fetch("http://[::ffff:169.254.169.254]/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("blocks fetch() to a hostname that resolves to loopback (localhost)", async () => {
    // Deterministic on Linux/macOS: resolver always hands back 127.0.0.1 or
    // ::1 for "localhost". Exercises the DNS-resolved path, not the IP-
    // literal path.
    const outcome = await runCode({
      code: `return await fetch("http://localhost/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("rejects fetch() with a non-http(s) scheme", async () => {
    const outcome = await runCode({
      code: `return await fetch("file:///etc/passwd");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("scheme not allowed");
    }
  });

  it("disallows require() inside the sandbox", async () => {
    const outcome = await runCode({
      code: `return require("fs");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toMatch(/require is not defined/i);
    }
  });

  it("round-trips Map via v8 serialization", async () => {
    const outcome = await runCode({
      code: `return new Map([["a", 1], ["b", 2]]);`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBeInstanceOf(Map);
      const asMap = outcome.result as Map<string, number>;
      expect(asMap.get("a")).toBe(1);
      expect(asMap.get("b")).toBe(2);
    }
  });
});
