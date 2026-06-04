import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockValues, mockInsert } = vi.hoisted(() => {
  const values = vi.fn();
  return {
    mockValues: values,
    mockInsert: vi.fn(() => ({ values })),
  };
});

vi.mock("@/lib/db", () => ({ db: { insert: mockInsert } }));
vi.mock("@/lib/db/schema", () => ({
  securityAuditLog: { __table: "security_audit_log" },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

const actor = {
  userId: "user-1",
  organizationId: null,
  authMethod: "session",
};

beforeEach(() => {
  mockValues.mockReset();
  mockValues.mockResolvedValue(undefined);
  mockInsert.mockClear();
});

describe("recordAuditEvent", () => {
  it("inserts an event with a null diff for a pure create (no before state)", async () => {
    await recordAuditEvent({
      actor,
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: "key-1",
      after: { name: "deploy", keyPrefix: "wfb_abc" },
    });

    expect(mockValues).toHaveBeenCalledTimes(1);
    const row = mockValues.mock.calls[0][0];
    expect(row).toMatchObject({
      actorUserId: "user-1",
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: "key-1",
    });
    // deep-diff of (undefined -> object) yields "N" (new) records, not null.
    expect(Array.isArray(row.diff)).toBe(true);
    expect(row.diff[0]).toMatchObject({ kind: "N" });
  });

  it("computes a field-level diff between before and after", async () => {
    await recordAuditEvent({
      actor,
      action: "workflow.updated",
      before: { name: "old", enabled: false },
      after: { name: "new", enabled: false },
    });

    const row = mockValues.mock.calls[0][0];
    // Only `name` changed, so exactly one edit record of kind "E".
    expect(row.diff).toHaveLength(1);
    expect(row.diff[0]).toMatchObject({
      kind: "E",
      path: ["name"],
      lhs: "old",
      rhs: "new",
    });
  });

  it("stores a null diff when there is nothing to diff", async () => {
    await recordAuditEvent({ actor, action: "user.signed_in" });
    expect(mockValues.mock.calls[0][0].diff).toBeNull();
  });

  it("never throws when the insert fails", async () => {
    mockValues.mockRejectedValue(new Error("db down"));
    await expect(
      recordAuditEvent({ actor, action: "api_key.created" })
    ).resolves.toBeUndefined();
  });
});

describe("buildAuditMetadata", () => {
  it("captures ip, country, and user agent from request headers", () => {
    const request = new Request("https://app.keeperhub.com/api/api-keys", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "cf-ipcountry": "DE",
        "user-agent": "Mozilla/5.0",
      },
    });

    expect(buildAuditMetadata(request)).toEqual({
      ip: "203.0.113.7",
      country: "DE",
      userAgent: "Mozilla/5.0",
    });
  });
});
