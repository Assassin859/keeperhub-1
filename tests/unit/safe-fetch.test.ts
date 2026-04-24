import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted ensures the spy exists before the mock factory runs — the
// factory is invoked when safe-fetch.ts imports @sentry/nextjs during ES
// module graph resolution, which is before top-level test file statements
// execute. A bare `const` would hit TDZ.
const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException,
}));

const incrementCounter = vi.fn();
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter,
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

import {
  isBlockedIp,
  SsrfBlockedError,
  type SsrfBlockReason,
  safeFetch,
} from "@/lib/safe-fetch";

const LABELSET_ERROR_RE = /initial labelset/i;

describe("isBlockedIp", () => {
  const blockedV4: [string, SsrfBlockReason][] = [
    ["0.0.0.0", "private-ip"],
    ["10.1.2.3", "private-ip"],
    ["100.64.0.1", "private-ip"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link-local"],
    ["172.16.0.1", "private-ip"],
    ["172.31.255.254", "private-ip"],
    ["192.168.0.1", "private-ip"],
    ["192.168.255.254", "private-ip"],
    ["198.18.0.1", "private-ip"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
  ];

  for (const [ip, reason] of blockedV4) {
    it(`blocks IPv4 ${ip} (${reason})`, () => {
      const result = isBlockedIp(ip);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.reason).toBe(reason);
      }
    });
  }

  const blockedV6: [string, SsrfBlockReason][] = [
    ["::", "private-ip"],
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fc00::1", "private-ip"],
    ["fd00::1", "private-ip"],
    ["ff02::1", "multicast"],
  ];

  for (const [ip, reason] of blockedV6) {
    it(`blocks IPv6 ${ip} (${reason})`, () => {
      const result = isBlockedIp(ip);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.reason).toBe(reason);
      }
    });
  }

  it("blocks IPv4-mapped-IPv6 dotted form (::ffff:169.254.169.254)", () => {
    const result = isBlockedIp("::ffff:169.254.169.254");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe("ipv4-mapped-private");
    }
  });

  it("blocks IPv4-mapped-IPv6 hex form (::ffff:a9fe:a9fe)", () => {
    const result = isBlockedIp("::ffff:a9fe:a9fe");
    expect(result.blocked).toBe(true);
  });

  const allowedV4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "185.60.216.35"];
  for (const ip of allowedV4) {
    it(`allows public IPv4 ${ip}`, () => {
      const result = isBlockedIp(ip);
      expect(result.blocked).toBe(false);
    });
  }

  const allowedV6 = ["2001:4860:4860::8888", "2606:4700:4700::1111"];
  for (const ip of allowedV6) {
    it(`allows public IPv6 ${ip}`, () => {
      const result = isBlockedIp(ip);
      expect(result.blocked).toBe(false);
    });
  }

  it("returns not-blocked for non-IP strings", () => {
    expect(isBlockedIp("example.com").blocked).toBe(false);
    expect(isBlockedIp("").blocked).toBe(false);
    expect(isBlockedIp("not-an-ip").blocked).toBe(false);
  });
});

describe("safeFetch (enforce mode)", () => {
  const originalEnforce = process.env.SAFE_FETCH_ENFORCE;

  beforeEach(() => {
    process.env.SAFE_FETCH_ENFORCE = "true";
    incrementCounter.mockClear();
    captureException.mockClear();
  });

  afterEach(() => {
    if (originalEnforce === undefined) {
      process.env.SAFE_FETCH_ENFORCE = undefined;
      // biome-ignore lint/performance/noDelete: ensure env var is fully removed
      delete process.env.SAFE_FETCH_ENFORCE;
    } else {
      process.env.SAFE_FETCH_ENFORCE = originalEnforce;
    }
  });

  const blockedSchemes = [
    "file:///etc/passwd",
    "data:text/plain,hello",
    "gopher://example.com/",
    "ftp://example.com/",
  ];

  for (const url of blockedSchemes) {
    it(`rejects scheme in ${url}`, async () => {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(incrementCounter).toHaveBeenCalledWith(
        "safe_fetch.blocks.total",
        expect.objectContaining({ reason: "scheme", shadow: "false" })
      );
    });
  }

  const blockedLiteralUrls = [
    ["http://127.0.0.1/", "loopback"],
    ["http://169.254.169.254/latest/meta-data/", "link-local"],
    ["http://10.0.0.1/", "private-ip"],
    ["http://192.168.1.1/", "private-ip"],
    ["http://[::1]/", "loopback"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[fc00::1]/", "private-ip"],
    ["http://[::ffff:169.254.169.254]/", "ipv4-mapped-private"],
  ];

  for (const [url, reason] of blockedLiteralUrls) {
    it(`rejects IP literal ${url} (${reason})`, async () => {
      await expect(safeFetch(url as string)).rejects.toBeInstanceOf(
        SsrfBlockedError
      );
      expect(incrementCounter).toHaveBeenCalledWith(
        "safe_fetch.blocks.total",
        expect.objectContaining({ reason, shadow: "false" })
      );
    });
  }

  it("labels plugin when provided", async () => {
    await expect(
      safeFetch("http://127.0.0.1/", { plugin: "code" })
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({ plugin_name: "code" })
    );
  });

  it("attributes plugin on DNS-resolved private IP (localhost)", async () => {
    // `localhost` is not an IP literal, so it reaches the DNS path and is
    // resolved inside the Agent's connector to 127.0.0.1 or ::1. The plugin
    // label must propagate there via AsyncLocalStorage. Port 9999 avoids
    // the WHATWG fetch "bad port" list (which includes port 1).
    await expect(
      safeFetch("http://localhost:9999/", { plugin: "webhook" })
    ).rejects.toThrow();
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({
        plugin_name: "webhook",
        reason: "loopback",
      })
    );
  });

  it("throws TypeError for malformed URLs", async () => {
    await expect(safeFetch("not a url")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("safeFetch (shadow mode)", () => {
  const originalEnforce = process.env.SAFE_FETCH_ENFORCE;

  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: default shadow requires unset
    delete process.env.SAFE_FETCH_ENFORCE;
    incrementCounter.mockClear();
    captureException.mockClear();
  });

  afterEach(() => {
    if (originalEnforce === undefined) {
      // biome-ignore lint/performance/noDelete: restore unset state
      delete process.env.SAFE_FETCH_ENFORCE;
    } else {
      process.env.SAFE_FETCH_ENFORCE = originalEnforce;
    }
  });

  it("records a block with shadow=true but does not throw SsrfBlockedError on IP literal", async () => {
    // The fetch itself will still fail to connect to 127.0.0.1 in the test
    // env (no listener). The important behaviour is that safe-fetch does
    // not short-circuit with SsrfBlockedError. Port 9999 avoids the
    // WHATWG fetch "bad port" list.
    try {
      await safeFetch("http://127.0.0.1:9999/");
    } catch (err) {
      expect(err).not.toBeInstanceOf(SsrfBlockedError);
    }
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({ reason: "loopback", shadow: "true" })
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          safe_fetch_reason: "loopback",
          safe_fetch_shadow: "true",
        }),
      })
    );
  });

  it("records scheme block with shadow=true on non-http URL", async () => {
    // undici will reject the scheme anyway; we just want to see the metric.
    await safeFetch("file:///etc/passwd").catch(() => undefined);
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({ reason: "scheme", shadow: "true" })
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          safe_fetch_reason: "scheme",
          safe_fetch_shadow: "true",
        }),
      })
    );
  });

  it("does not throw a Prometheus labelset error from recordBlock (regression)", async () => {
    // Regression for KEEP-314: recordBlock originally routed the block log
    // through logUserError, which forwarded caller-supplied labels
    // (hostname, resolved_ip, shadow_mode) to a Prometheus error metric
    // with a fixed initial labelset. prom-client then threw "Added label
    // not included in initial labelset" from inside the fetch pipeline,
    // making shadow mode fatal for any workflow that hit a blocked IP.
    //
    // Uses loopback rather than link-local to avoid network-layer flake
    // (connect timeouts on 169.254.x.x vary by runner). recordBlock runs
    // synchronously before any network call, so the bug reproduces
    // regardless of which reason the block carries.
    let thrown: unknown;
    try {
      await safeFetch("http://127.0.0.1:9999/", { plugin: "code" });
    } catch (err) {
      thrown = err;
    }
    if (thrown !== undefined) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).not.toMatch(LABELSET_ERROR_RE);
    }
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          safe_fetch_reason: "loopback",
          safe_fetch_shadow: "true",
          plugin_name: "code",
        }),
      })
    );
  });
});
