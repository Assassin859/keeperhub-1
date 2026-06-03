import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedis, mockSendEmail } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockSendEmail: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@/lib/email", () => ({ sendNewIpAttemptEmail: mockSendEmail }));
vi.mock("@/lib/security/device-label", () => ({
  describeUserAgentLabel: (ua: string | null) => ua ?? "Unknown device",
}));
// Mock only the logger we depend on so the test doesn't pull the DB client
// (and the rest of login-risk) into the unit env.
vi.mock("@/lib/security/login-risk", () => ({ logIpVerify: vi.fn() }));

import { newIpNotifyClaimKey } from "@/lib/redis-keys";
import {
  claimNewIpNotification,
  maybeNotifyNewIp,
  NEW_IP_NOTIFY_TTL_SECONDS,
} from "@/lib/security/new-ip-notification";

type SetFn = (...args: unknown[]) => Promise<unknown>;
function redisWithSet(set: SetFn): { set: SetFn } {
  return { set };
}

// Each test uses a distinct userId so the module-level per-pod dedup set
// (which persists across tests in this file) never bleeds between cases.
let userSeq = 0;
function freshUser(): string {
  userSeq += 1;
  return `user-${userSeq}`;
}

beforeEach(() => {
  mockGetRedis.mockReset();
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue(true);
});

describe("newIpNotifyClaimKey", () => {
  it("namespaces under ip-notify with user and normalized ip", () => {
    expect(newIpNotifyClaimKey("u1", "1.2.3.0")).toBe("ip-notify:u1:1.2.3.0");
  });
});

describe("claimNewIpNotification", () => {
  it("returns false (skip) when no Redis is configured", async () => {
    mockGetRedis.mockReturnValue(null);
    await expect(claimNewIpNotification("u1", "1.2.3.0")).resolves.toBe(false);
  });

  it("returns true and claims with NX + EX TTL when the key was set", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    mockGetRedis.mockReturnValue(redisWithSet(set));

    await expect(claimNewIpNotification("u1", "1.2.3.0")).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(
      "ip-notify:u1:1.2.3.0",
      "1",
      "EX",
      NEW_IP_NOTIFY_TTL_SECONDS,
      "NX"
    );
  });

  it("returns false (skip) when another replica already holds the key", async () => {
    mockGetRedis.mockReturnValue(redisWithSet(vi.fn().mockResolvedValue(null)));
    await expect(claimNewIpNotification("u1", "1.2.3.0")).resolves.toBe(false);
  });

  it("returns false (skip) when the Redis command throws", async () => {
    mockGetRedis.mockReturnValue(
      redisWithSet(vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))
    );
    await expect(claimNewIpNotification("u1", "1.2.3.0")).resolves.toBe(false);
  });
});

describe("maybeNotifyNewIp", () => {
  it("sends once when the claim is won, with the resolved device label", async () => {
    mockGetRedis.mockReturnValue(redisWithSet(vi.fn().mockResolvedValue("OK")));
    const userId = freshUser();

    maybeNotifyNewIp({
      userId,
      email: "a@b.com",
      ip: "9.9.9.0",
      country: "DE",
      userAgent: "Mozilla/5.0",
    });

    await vi.waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "a@b.com",
        ip: "9.9.9.0",
        country: "DE",
        device: "Mozilla/5.0",
      })
    );
  });

  it("does not send when another replica already claimed", async () => {
    mockGetRedis.mockReturnValue(redisWithSet(vi.fn().mockResolvedValue(null)));

    maybeNotifyNewIp({
      userId: freshUser(),
      email: "a@b.com",
      ip: "9.9.9.0",
      country: null,
      userAgent: null,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends once across a fan-out: only the SET NX winner delivers", async () => {
    // SET NX is atomic in Redis: the first call sets the key ("OK"), the rest
    // see it exists (null). The mock mirrors that so concurrent requests for
    // the same network produce exactly one email with no local dedup.
    const set = vi.fn().mockResolvedValueOnce("OK").mockResolvedValue(null);
    mockGetRedis.mockReturnValue(redisWithSet(set));
    const notification = {
      userId: freshUser(),
      email: "a@b.com",
      ip: "9.9.9.0",
      country: null,
      userAgent: null,
    };

    maybeNotifyNewIp(notification);
    maybeNotifyNewIp(notification);
    maybeNotifyNewIp(notification);

    await vi.waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("skips entirely when userId or ip is empty", async () => {
    mockGetRedis.mockReturnValue(redisWithSet(vi.fn().mockResolvedValue("OK")));

    maybeNotifyNewIp({
      userId: "",
      email: "a@b.com",
      ip: "9.9.9.0",
      country: null,
      userAgent: null,
    });
    maybeNotifyNewIp({
      userId: freshUser(),
      email: "a@b.com",
      ip: "",
      country: null,
      userAgent: null,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
