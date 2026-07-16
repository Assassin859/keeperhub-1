import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logUserError: vi.fn(),
}));
vi.mock("@/lib/utils", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const mockResolveOrganizationContext = vi.fn();
vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: (...args: unknown[]) =>
    mockResolveOrganizationContext(...args),
}));

const mockBuildTempoTxLink = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-step-helpers", () => ({
  buildTempoTxLink: (...args: unknown[]) => mockBuildTempoTxLink(...args),
}));

const mockBroadcast = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  broadcastStoredTempoTx: (...args: unknown[]) => mockBroadcast(...args),
}));

const mockGetForOrg = vi.fn();
const mockClaim = vi.fn();
const mockMarkConfirmed = vi.fn();
const mockMarkFailed = vi.fn();
vi.mock("@/lib/tempo/held-payments", () => ({
  getHeldPaymentForOrg: (...args: unknown[]) => mockGetForOrg(...args),
  claimHeldPayment: (...args: unknown[]) => mockClaim(...args),
  markConfirmed: (...args: unknown[]) => mockMarkConfirmed(...args),
  markFailed: (...args: unknown[]) => mockMarkFailed(...args),
}));

import {
  type BroadcastHeldPaymentInput,
  broadcastHeldPaymentStep,
} from "@/plugins/tempo/steps/broadcast-held-payment";

const NOW_SEC = 1_800_000_000;
const FROM = "0xFROM";
const TO = "0x1111111111111111111111111111111111111111";

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "held-1",
    organizationId: "org1",
    chainId: 42_431,
    serializedTx: "0x76blob",
    precomputedHash: "0xhash",
    fromAddress: FROM,
    toAddress: TO,
    validBefore: NOW_SEC + 3600,
    status: "pending",
    ...overrides,
  };
}

function input(paymentId = "held-1"): BroadcastHeldPaymentInput {
  return {
    paymentId,
    _context: { organizationId: "org1", executionId: "exec1" },
  } as BroadcastHeldPaymentInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
  mockResolveOrganizationContext.mockResolvedValue({
    success: true,
    organizationId: "org1",
    userId: "u1",
  });
  mockBuildTempoTxLink.mockResolvedValue("https://explorer/tx/0xsent");
  mockBroadcast.mockResolvedValue({ hash: "0xsent", confirmed: true });
  mockMarkConfirmed.mockResolvedValue({});
  mockMarkFailed.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("broadcastHeldPaymentStep", () => {
  it("claims, broadcasts, and confirms a pending held payment", async () => {
    mockGetForOrg.mockResolvedValue(pendingRow());
    mockClaim.mockResolvedValue(pendingRow({ status: "broadcasting" }));

    const res = await broadcastHeldPaymentStep(input());

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.transactionHash).toBe("0xsent");
      expect(res.transactionLink).toBe("https://explorer/tx/0xsent");
      expect(res.status).toBe("confirmed");
      expect(res.from).toBe(FROM);
    }
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        serialized: "0x76blob",
        expectedHash: "0xhash",
        waitForConfirmation: true,
      })
    );
    expect(mockMarkConfirmed).toHaveBeenCalledWith("held-1", "0xsent");
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("returns not-found when the payment is missing or another org's", async () => {
    mockGetForOrg.mockResolvedValue(null);
    const res = await broadcastHeldPaymentStep(input());
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("was not found");
    }
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("refuses a payment whose window has already closed", async () => {
    mockGetForOrg.mockResolvedValue(pendingRow({ validBefore: NOW_SEC - 5 }));
    const res = await broadcastHeldPaymentStep(input());
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("window has closed");
    }
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("no-ops when the row is not pending (lost the claim)", async () => {
    mockGetForOrg.mockResolvedValue(pendingRow({ status: "broadcast" }));
    mockClaim.mockResolvedValue(null);

    const res = await broadcastHeldPaymentStep(input());
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("not pending");
    }
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("marks the payment failed when the broadcast throws", async () => {
    mockGetForOrg.mockResolvedValue(pendingRow());
    mockClaim.mockResolvedValue(pendingRow({ status: "broadcasting" }));
    mockBroadcast.mockRejectedValue(new Error("node rejected: underpriced"));

    const res = await broadcastHeldPaymentStep(input());
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("underpriced");
    }
    expect(mockMarkFailed).toHaveBeenCalledWith(
      "held-1",
      "node rejected: underpriced"
    );
    expect(mockMarkConfirmed).not.toHaveBeenCalled();
  });
});
