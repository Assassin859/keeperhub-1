import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ── Mocks (before imports) ───────────────────────────────────────────

vi.mock("server-only", () => ({}));

// Capture what createSmartAccountClient is called with so we can pull the
// estimateFeesPerGas callback back out and exercise it directly. Returns
// an opaque client - not exercised in these tests.
const mockCreateSmartAccountClient: Mock = vi.fn((_args: unknown) => ({}));
vi.mock("permissionless", () => ({
  createSmartAccountClient: (...args: unknown[]) =>
    mockCreateSmartAccountClient(...args),
}));

// Pimlico client returns whatever the test has currently set on the spy.
const mockGetUserOperationGasPrice = vi.fn();
vi.mock("permissionless/clients/pimlico", () => ({
  createPimlicoClient: () => ({
    getUserOperationGasPrice: (...args: unknown[]) =>
      mockGetUserOperationGasPrice(...args),
  }),
}));

// Stubs for everything else createSponsoredClient touches before reaching
// the createSmartAccountClient call.
vi.mock("permissionless/accounts", () => ({
  to7702SimpleSmartAccount: vi.fn().mockResolvedValue({
    isDeployed: vi.fn().mockResolvedValue(true),
  }),
}));
vi.mock("viem", () => ({
  createPublicClient: vi.fn().mockReturnValue({}),
  defineChain: vi.fn().mockReturnValue({}),
  http: vi.fn().mockReturnValue({}),
}));
vi.mock("viem/account-abstraction", () => ({ entryPoint08Address: "0x0" }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      chains: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ name: "Sepolia", symbol: "ETH" }),
      },
    },
  },
}));
vi.mock("@/lib/db/schema", () => ({ chains: { chainId: "chainId" } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemError: vi.fn(),
}));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    recordError: vi.fn(),
    incrementCounter: vi.fn(),
  }),
}));
vi.mock("@/lib/metrics/types", () => ({
  LabelKeys: {},
  MetricNames: {},
}));
vi.mock("@/lib/web3/turnkey-viem-account", () => ({
  createTurnkeyViemAccount: vi.fn().mockResolvedValue({
    account: { address: "0xabc" },
    walletRecord: { walletAddress: "0xabc" },
  }),
}));
vi.mock("@/lib/web3/eip7702-delegation", () => ({
  recordDelegationIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/web3/pimlico-config", () => ({
  getPimlicoUrl: vi.fn().mockReturnValue("https://pimlico.test"),
  isSponsorshipSupported: vi.fn().mockReturnValue(true),
}));

// ── Import under test ────────────────────────────────────────────────

import { createSponsoredClient } from "@/lib/web3/sponsored-client";

// ── Helpers ──────────────────────────────────────────────────────────

type EstimateFeesPerGas = () => Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}>;

type CapturedClientArgs = {
  userOperation?: { estimateFeesPerGas?: EstimateFeesPerGas };
};

async function buildSponsoredClient(): Promise<{
  result: unknown;
  args: CapturedClientArgs | undefined;
}> {
  const result = await createSponsoredClient(
    "org-id",
    11_155_111,
    "https://sepolia.test"
  );
  const args = (mockCreateSmartAccountClient as Mock).mock.calls[0]?.[0] as
    | CapturedClientArgs
    | undefined;
  return { result, args };
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSponsoredClient estimateFeesPerGas wiring", () => {
  // KEEP-394: this test guarantees the clamp helper is actually invoked
  // before the fee pair reaches the smart account client. If someone
  // removes the clampSponsoredFees() call and passes gasPrices.fast
  // through directly, this fails.
  it("clamps Pimlico's invalid fee pair before returning to the bundler", async () => {
    mockGetUserOperationGasPrice.mockResolvedValue({
      fast: {
        maxFeePerGas: BigInt(2_463_760),
        maxPriorityFeePerGas: BigInt(100_000_000),
      },
    });

    const { result, args } = await buildSponsoredClient();
    expect(result).not.toBeNull();
    const estimateFeesPerGas = args?.userOperation?.estimateFeesPerGas;
    expect(estimateFeesPerGas).toBeTypeOf("function");

    const fees = await (estimateFeesPerGas as EstimateFeesPerGas)();

    expect(fees.maxFeePerGas).toBeGreaterThanOrEqual(fees.maxPriorityFeePerGas);
    expect(fees.maxFeePerGas).toBe(BigInt(100_000_000));
    expect(fees.maxPriorityFeePerGas).toBe(BigInt(100_000_000));
  });

  it("passes a valid Pimlico fee pair through unchanged", async () => {
    const validPair = {
      maxFeePerGas: BigInt(50_000_000_000),
      maxPriorityFeePerGas: BigInt(2_000_000_000),
    };
    mockGetUserOperationGasPrice.mockResolvedValue({ fast: validPair });

    const { result, args } = await buildSponsoredClient();
    expect(result).not.toBeNull();
    const estimateFeesPerGas = args?.userOperation?.estimateFeesPerGas;
    expect(estimateFeesPerGas).toBeTypeOf("function");

    const fees = await (estimateFeesPerGas as EstimateFeesPerGas)();

    expect(fees.maxFeePerGas).toBe(BigInt(50_000_000_000));
    expect(fees.maxPriorityFeePerGas).toBe(BigInt(2_000_000_000));
  });
});
