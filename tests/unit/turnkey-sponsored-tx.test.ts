import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    EXTERNAL_SERVICE: "external_service",
    TRANSACTION: "transaction",
  },
  logSystemError: vi.fn(),
}));

const mockEthSend = vi.fn();
const mockGetStatus = vi.fn();

vi.mock("@/lib/turnkey/agentic-wallet", () => ({
  getTurnkeyClientForOrg: () => ({
    apiClient: () => ({
      ethSendTransaction: (...args: unknown[]) => mockEthSend(...args),
      getSendTransactionStatus: (...args: unknown[]) => mockGetStatus(...args),
    }),
  }),
}));

vi.mock("@/lib/web3/turnkey-sponsorship-config", () => ({
  toCaip2: (chainId: number) => `eip155:${chainId}`,
}));

// turnkey-revert is intentionally NOT mocked so `instanceof SponsoredTxRevertError`
// works against the real class.
import { SponsoredTxRevertError } from "@/lib/web3/turnkey-revert";
import { submitTurnkeySponsoredTransaction } from "@/lib/web3/turnkey-sponsored-tx";

const SEPOLIA = 11_155_111;
// Generic, lowercased test address (not a real wallet); getAddress() yields its
// EIP-55 checksum, which is what Turnkey must receive.
const LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CHECKSUMMED = getAddress(LOWER);

function baseParams() {
  return {
    subOrgId: "sub-org-test",
    walletAddress: LOWER,
    chainId: SEPOLIA,
    to: "0x000000000000000000000000000000000000dead",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("submitTurnkeySponsoredTransaction", () => {
  it("sends the EIP-55 checksummed `from` to Turnkey (not the lowercase DB value)", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-1" });
    mockGetStatus.mockResolvedValue({
      txStatus: "INCLUDED",
      eth: { txHash: "0xhash1" },
    });

    await submitTurnkeySponsoredTransaction(baseParams());

    expect(mockEthSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: CHECKSUMMED, sponsor: true })
    );
    expect(CHECKSUMMED).not.toBe(LOWER);
  });

  it("returns the tx hash once Turnkey reports INCLUDED", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-2" });
    mockGetStatus.mockResolvedValue({
      txStatus: "INCLUDED",
      eth: { txHash: "0xhash2" },
    });

    const result = await submitTurnkeySponsoredTransaction(baseParams());

    expect(result).toEqual({
      txHash: "0xhash2",
      sendTransactionStatusId: "sid-2",
    });
  });

  it("throws SponsoredTxRevertError on a post-broadcast revert (FAILED + hash)", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-3" });
    mockGetStatus.mockResolvedValue({
      txStatus: "FAILED",
      txError: "execution reverted",
      eth: { txHash: "0xrevert" },
      error: { eth: { revertChain: [] } },
    });

    await expect(
      submitTurnkeySponsoredTransaction(baseParams())
    ).rejects.toBeInstanceOf(SponsoredTxRevertError);
  });

  it("returns null on a pre-broadcast failure (FAILED, no hash) so the caller falls back", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-4" });
    mockGetStatus.mockResolvedValue({ txStatus: "FAILED", eth: {} });

    const result = await submitTurnkeySponsoredTransaction(baseParams());

    expect(result).toBeNull();
  });

  it("returns null when ethSendTransaction rejects", async () => {
    mockEthSend.mockRejectedValue(
      new Error("Turnkey error 5: Could not find any resource to sign with")
    );

    const result = await submitTurnkeySponsoredTransaction(baseParams());

    expect(result).toBeNull();
  });
});
