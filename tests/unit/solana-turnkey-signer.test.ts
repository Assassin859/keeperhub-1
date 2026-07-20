import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PolicyBlockedError,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign";
import { TurnkeySolanaSigner } from "@/lib/agentic-wallet/solana-turnkey-signer";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";

vi.mock("@/lib/turnkey/agentic-wallet", () => ({
  getTurnkeyClientForOrg: vi.fn(),
}));

describe("TurnkeySolanaSigner", () => {
  const mockSubOrgId = "mock-sub-org-id";
  const mockSolanaAddress = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  let mockApiClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = {
      signTransaction: vi.fn(),
    };
    vi.mocked(getTurnkeyClientForOrg).mockReturnValue({
      apiClient: () => mockApiClient,
    } as any);
  });

  it("getPublicKey returns correct PublicKey instance", async () => {
    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    const pubkey = await signer.getPublicKey();
    expect(pubkey.toBase58()).toBe(mockSolanaAddress);
  });

  it("signTransaction hex-encodes the request and hex-decodes the response", async () => {
    const mockUnsignedBytes = new Uint8Array([1, 2, 3]);
    // Turnkey speaks hex for both the unsigned request and the signed result.
    const mockSignedHex = Buffer.from(new Uint8Array([4, 5, 6])).toString(
      "hex"
    );

    mockApiClient.signTransaction.mockResolvedValue({
      activity: {
        status: "ACTIVITY_STATUS_COMPLETED",
        result: {
          signTransactionResult: {
            signedTransaction: mockSignedHex,
          },
        },
      },
    });

    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    const result = await signer.signTransaction(mockUnsignedBytes);

    expect(result).toEqual(new Uint8Array([4, 5, 6]));
    expect(mockApiClient.signTransaction).toHaveBeenCalledWith({
      signWith: mockSolanaAddress,
      type: "TRANSACTION_TYPE_SOLANA",
      unsignedTransaction: Buffer.from(mockUnsignedBytes).toString("hex"),
    });

    // Regression guard: Turnkey rejects non-hex payloads with
    // "failed to decode Solana transaction: encoding/hex: invalid byte".
    // A base64 payload would contain non-hex characters (e.g. uppercase, +, /, =).
    const sentPayload =
      mockApiClient.signTransaction.mock.calls[0][0].unsignedTransaction;
    expect(sentPayload).toMatch(/^[0-9a-f]*$/);
  });

  it("throws PolicyBlockedError when status is consensus needed", async () => {
    mockApiClient.signTransaction.mockResolvedValue({
      activity: {
        status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
      },
    });

    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    await expect(
      signer.signTransaction(new Uint8Array([1, 2, 3]))
    ).rejects.toThrow(PolicyBlockedError);
  });

  it("throws TurnkeyUpstreamError when status is not completed", async () => {
    mockApiClient.signTransaction.mockResolvedValue({
      activity: {
        status: "ACTIVITY_STATUS_PENDING",
      },
    });

    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    await expect(
      signer.signTransaction(new Uint8Array([1, 2, 3]))
    ).rejects.toThrow(TurnkeyUpstreamError);
  });

  it("throws TurnkeyUpstreamError when signedTransaction is missing", async () => {
    mockApiClient.signTransaction.mockResolvedValue({
      activity: {
        status: "ACTIVITY_STATUS_COMPLETED",
        result: {
          signTransactionResult: {},
        },
      },
    });

    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    await expect(
      signer.signTransaction(new Uint8Array([1, 2, 3]))
    ).rejects.toThrow(TurnkeyUpstreamError);
  });
});
