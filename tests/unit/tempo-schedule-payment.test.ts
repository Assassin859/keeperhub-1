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

const mockGetChainIdFromNetwork = vi.fn();
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

const mockGetRpcProvider = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
}));

const mockResolveOrganizationContext = vi.fn();
vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: (...args: unknown[]) =>
    mockResolveOrganizationContext(...args),
}));

const mockAssertTempoChain = vi.fn();
const mockResolveTempoToken = vi.fn();
const mockBuildTempoTxLink = vi.fn();
const UNIX_RE = /^\d+$/;
vi.mock("@/plugins/tempo/steps/tempo-step-helpers", () => ({
  assertTempoChain: (...args: unknown[]) => mockAssertTempoChain(...args),
  resolveTempoToken: (...args: unknown[]) => mockResolveTempoToken(...args),
  buildTempoTxLink: (...args: unknown[]) => mockBuildTempoTxLink(...args),
  // Faithful inline copy so the window logic gets real parsing.
  parseTimestamp: (raw?: string): number | undefined => {
    if (!raw || raw.trim() === "") {
      return;
    }
    const v = raw.trim();
    if (UNIX_RE.test(v)) {
      const n = Number(v);
      return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid date "${v}"`);
    }
    return Math.floor(ms / 1000);
  },
}));

const mockSignAndBroadcast = vi.fn();
const mockBuildCall = vi.fn();
const mockNormalizeMemo = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  signAndBroadcastTempoTx: (...args: unknown[]) =>
    mockSignAndBroadcast(...args),
  buildTransferWithMemoCall: (...args: unknown[]) => mockBuildCall(...args),
  normalizeMemo: (...args: unknown[]) => mockNormalizeMemo(...args),
}));

import {
  type SchedulePaymentInput,
  schedulePaymentStep,
} from "@/plugins/tempo/steps/schedule-payment";

const USDC = "0x20c0000000000000000000000000000000000001";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NOW_SEC = 1_800_000_000;

function baseInput(
  overrides: Partial<SchedulePaymentInput> = {}
): SchedulePaymentInput {
  return {
    network: "tempo-testnet",
    tokenConfig: { supportedTokenId: "usdc" },
    amount: "500",
    recipientAddress: RECIPIENT,
    memo: "PAYRUN-2026-07",
    _context: { organizationId: "org1", executionId: "exec1" },
    ...overrides,
  } as SchedulePaymentInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
  mockGetChainIdFromNetwork.mockReturnValue(42_431);
  mockAssertTempoChain.mockReturnValue(undefined);
  mockResolveOrganizationContext.mockResolvedValue({
    success: true,
    organizationId: "org1",
    userId: "u1",
  });
  mockGetRpcProvider.mockResolvedValue({});
  mockResolveTempoToken.mockResolvedValue({
    address: USDC,
    decimals: 6,
    symbol: "USDC",
  });
  mockNormalizeMemo.mockReturnValue("0xMEMO");
  mockBuildCall.mockReturnValue({ to: USDC, data: "0xdata" });
  mockSignAndBroadcast.mockResolvedValue({ hash: "0xhash", from: "0xFROM" });
  mockBuildTempoTxLink.mockResolvedValue("https://explorer/tx/0xhash");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("schedulePaymentStep", () => {
  it("signs with the explicit inclusion window", async () => {
    const res = await schedulePaymentStep(
      baseInput({ validBefore: String(NOW_SEC + 3600) })
    );

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.transactionHash).toBe("0xhash");
      expect(res.validBefore).toBe(NOW_SEC + 3600);
      expect(res.validAfter).toBeNull();
    }
    const args = mockSignAndBroadcast.mock.calls[0][0];
    expect(args.validBefore).toBe(NOW_SEC + 3600);
    expect(args.validAfter).toBeUndefined();
  });

  it("defaults validBefore to a short window when unset", async () => {
    await schedulePaymentStep(baseInput());
    const args = mockSignAndBroadcast.mock.calls[0][0];
    expect(args.validBefore).toBe(NOW_SEC + 900);
  });

  it("passes an explicit validAfter through", async () => {
    await schedulePaymentStep(
      baseInput({
        validAfter: String(NOW_SEC - 60),
        validBefore: String(NOW_SEC + 3600),
      })
    );
    const args = mockSignAndBroadcast.mock.calls[0][0];
    expect(args.validAfter).toBe(NOW_SEC - 60);
  });

  it("rejects a validAfter in the future (no deferred broadcast)", async () => {
    const res = await schedulePaymentStep(
      baseInput({ validAfter: String(NOW_SEC + 1000) })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("validAfter is in the future");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a validBefore in the past (inside the inclusion buffer)", async () => {
    const res = await schedulePaymentStep(
      baseInput({ validBefore: String(NOW_SEC - 10) })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("too soon");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a validBefore that closes inside the inclusion buffer", async () => {
    const res = await schedulePaymentStep(
      baseInput({ validBefore: String(NOW_SEC + 10) })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("too soon");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("accepts a validBefore just past the inclusion buffer", async () => {
    const res = await schedulePaymentStep(
      baseInput({ validBefore: String(NOW_SEC + 61) })
    );
    expect(res.success).toBe(true);
    expect(mockSignAndBroadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects an unparseable date", async () => {
    const res = await schedulePaymentStep(
      baseInput({ validBefore: "not-a-date" })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Invalid date");
    }
  });

  it("rejects an invalid recipient", async () => {
    const res = await schedulePaymentStep(
      baseInput({ recipientAddress: "nope" })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Invalid recipient");
    }
  });
});
