import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentKey, newIpNotifyClaimKey } from "@/lib/redis-keys";

describe("deploymentKey", () => {
  it("prefixes a single part with the default 'local' namespace", () => {
    expect(deploymentKey("a")).toBe("local:a");
  });

  it("joins multiple parts under the namespace", () => {
    expect(deploymentKey("a", "b", "c")).toBe("local:a:b:c");
  });
});

describe("newIpNotifyClaimKey", () => {
  it("builds an ip-notify key through deploymentKey", () => {
    expect(newIpNotifyClaimKey("u1", "1.2.3.0")).toBe(
      "local:ip-notify:u1:1.2.3.0"
    );
  });
});

describe("REDIS_KEY_PREFIX per deployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("namespaces keys with the configured prefix", async () => {
    // The prefix is read at module load, so reset + re-import after stubbing.
    vi.stubEnv("REDIS_KEY_PREFIX", "staging");
    vi.resetModules();
    const mod = await import("@/lib/redis-keys");

    expect(mod.deploymentKey("ip-notify", "u1", "1.2.3.0")).toBe(
      "staging:ip-notify:u1:1.2.3.0"
    );
    expect(mod.newIpNotifyClaimKey("u1", "1.2.3.0")).toBe(
      "staging:ip-notify:u1:1.2.3.0"
    );
  });

  it("isolates two deployments sharing one Redis instance", async () => {
    vi.stubEnv("REDIS_KEY_PREFIX", "pr-42");
    vi.resetModules();
    const mod = await import("@/lib/redis-keys");

    // Same user + ip on a different deployment lands on a different key.
    expect(mod.newIpNotifyClaimKey("u1", "1.2.3.0")).not.toBe(
      "staging:ip-notify:u1:1.2.3.0"
    );
    expect(mod.newIpNotifyClaimKey("u1", "1.2.3.0")).toBe(
      "pr-42:ip-notify:u1:1.2.3.0"
    );
  });
});
