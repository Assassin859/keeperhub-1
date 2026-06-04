import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendApiKeyChangeEmail } = vi.hoisted(() => ({
  mockSendApiKeyChangeEmail: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendApiKeyChangeEmail: mockSendApiKeyChangeEmail,
}));

import { notifyApiKeyChange } from "@/lib/security/api-key-notification";

const baseEvent = {
  email: "owner@example.com",
  action: "created" as const,
  tokenName: "CI deploy key",
  keyPrefix: "wfb_abc123",
  when: new Date("2026-06-03T00:00:00.000Z"),
};

beforeEach(() => {
  mockSendApiKeyChangeEmail.mockReset();
  mockSendApiKeyChangeEmail.mockResolvedValue(true);
});

describe("notifyApiKeyChange", () => {
  it("forwards the create event to the email helper", async () => {
    notifyApiKeyChange(baseEvent);

    await vi.waitFor(() =>
      expect(mockSendApiKeyChangeEmail).toHaveBeenCalledTimes(1)
    );
    expect(mockSendApiKeyChangeEmail).toHaveBeenCalledWith(baseEvent);
  });

  it("forwards the revoke event to the email helper", async () => {
    notifyApiKeyChange({ ...baseEvent, action: "revoked" });

    await vi.waitFor(() =>
      expect(mockSendApiKeyChangeEmail).toHaveBeenCalledTimes(1)
    );
    expect(mockSendApiKeyChangeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ action: "revoked" })
    );
  });

  it("skips entirely when there is no recipient email", () => {
    notifyApiKeyChange({ ...baseEvent, email: "" });
    expect(mockSendApiKeyChangeEmail).not.toHaveBeenCalled();
  });

  it("swallows a delivery rejection without throwing", async () => {
    mockSendApiKeyChangeEmail.mockRejectedValue(new Error("SendGrid down"));
    expect(() => notifyApiKeyChange(baseEvent)).not.toThrow();
    await vi.waitFor(() =>
      expect(mockSendApiKeyChangeEmail).toHaveBeenCalledTimes(1)
    );
  });
});
