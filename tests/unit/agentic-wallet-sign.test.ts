/**
 * Wave 0 RED scaffold for lib/agentic-wallet/sign.ts.
 *
 * Contract anchors:
 *   - 33-RESEARCH.md Pattern 3 (lines 367-444) -- x402 EIP-3009 signing shape
 *   - 33-RESEARCH.md Pattern 4 (lines 448-470) -- MPP proof-mode EIP-712
 *   - 33-RESEARCH.md Pitfall 7 -- CONSENSUS_NEEDED maps to POLICY_BLOCKED
 *
 * The helpers must call Turnkey signRawPayload with PAYLOAD_ENCODING_EIP712 +
 * HASH_FUNCTION_NO_OP and return a 132-char 0x-prefixed 65-byte signature
 * (v-parity bumped by 27 per @turnkey/ethers::serializeSignature).
 *
 * Baseline: every case throws because both helpers are stubs. Plan 33-02
 * flips this suite GREEN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSignRawPayload } = vi.hoisted(() => ({
  mockSignRawPayload: vi.fn(),
}));

vi.mock("@turnkey/sdk-server", () => ({
  // Named function expression (not an arrow) so `new Turnkey(...)` is
  // constructable under vitest 4.x. Arrow fns lack [[Construct]] and throw
  // "is not a constructor". See 33-01a summary deviation #2 for the same fix.
  Turnkey: vi.fn(function TurnkeyMock(this: unknown): {
    apiClient: () => { signRawPayload: typeof mockSignRawPayload };
  } {
    return {
      apiClient: (): { signRawPayload: typeof mockSignRawPayload } => ({
        signRawPayload: mockSignRawPayload,
      }),
    };
  }),
}));

const { PolicyBlockedError, signMppProof, signX402Challenge } = await import(
  "@/lib/agentic-wallet/sign"
);

const SUB_ORG = "subOrg_sign_test";
const WALLET = "0xabc000000000000000000000000000000000dead";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function happyPathResult(
  v: "00" | "01"
): Record<string, unknown> {
  return {
    activity: {
      status: "ACTIVITY_STATUS_COMPLETED",
      result: {
        signRawPayloadResult: {
          // r is arbitrary 32 bytes. s MUST be canonical (low-s per EIP-2);
          // the secp256k1 half-order is ~0x7FFF...5D57..., so all-"bb"
          // (0xbb...) is high-s and ethers 6 rejects it with "non-canonical
          // s". Use "11".repeat(32) — safely below the half-order boundary.
          r: "aa".repeat(32),
          s: "11".repeat(32),
          v,
        },
      },
    },
  };
}

describe("signX402Challenge", () => {
  beforeEach(() => {
    process.env.TURNKEY_API_PUBLIC_KEY = "test-pub";
    process.env.TURNKEY_API_PRIVATE_KEY = "test-priv";
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    mockSignRawPayload.mockReset();
    mockSignRawPayload.mockResolvedValue(happyPathResult("00"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls signRawPayload with flat EIP-712 args (Turnkey SDK v5.3.0 contract)", async () => {
    await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: `0x${"11".repeat(32)}`,
    });
    expect(mockSignRawPayload).toHaveBeenCalledTimes(1);
    const args = mockSignRawPayload.mock.calls[0]?.[0];
    expect(args.signWith).toBe(WALLET);
    expect(args.encoding).toBe("PAYLOAD_ENCODING_EIP712");
    expect(args.hashFunction).toBe("HASH_FUNCTION_NO_OP");
  });

  it("serialises typed data with chainId 8453, Base USDC verifying contract, and primaryType TransferWithAuthorization", async () => {
    await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: 1,
      nonce: `0x${"11".repeat(32)}`,
    });
    const args = mockSignRawPayload.mock.calls[0]?.[0];
    const typedData = JSON.parse(args.payload) as {
      domain: { chainId: number; verifyingContract: string };
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    expect(typedData.domain.chainId).toBe(8453);
    expect(typedData.domain.verifyingContract).toBe(BASE_USDC);
    expect(typedData.primaryType).toBe("TransferWithAuthorization");
    expect(typedData.types).toBeDefined();
    expect(typedData.message).toBeDefined();
  });

  it("returns a 0x-prefixed 132-char (65-byte) signature string", async () => {
    const sig = await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: 1,
      nonce: `0x${"11".repeat(32)}`,
    });
    expect(sig.startsWith("0x")).toBe(true);
    expect(sig.length).toBe(132);
  });

  it("maps Turnkey v:'00' to trailing 1b (v+27 = 27 = 0x1b)", async () => {
    mockSignRawPayload.mockResolvedValueOnce(happyPathResult("00"));
    const sig = await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: 1,
      nonce: `0x${"11".repeat(32)}`,
    });
    expect(sig.slice(-2)).toBe("1b");
  });

  it("maps Turnkey v:'01' to trailing 1c (v+27 = 28 = 0x1c)", async () => {
    mockSignRawPayload.mockResolvedValueOnce(happyPathResult("01"));
    const sig = await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: 1,
      nonce: `0x${"11".repeat(32)}`,
    });
    expect(sig.slice(-2)).toBe("1c");
  });

  it("throws PolicyBlockedError when Turnkey responds with ACTIVITY_STATUS_CONSENSUS_NEEDED", async () => {
    mockSignRawPayload.mockResolvedValueOnce({
      activity: { status: "ACTIVITY_STATUS_CONSENSUS_NEEDED" },
    });
    // Callers (including the /sign route) discriminate via
    // `instanceof PolicyBlockedError`, not by substring-matching .message.
    // The HTTP `code: "POLICY_BLOCKED"` response is asserted separately in
    // tests/integration/agentic-wallet-sign-route.test.ts.
    await expect(
      signX402Challenge(SUB_ORG, WALLET, {
        payTo: "0x1111111111111111111111111111111111111111",
        amount: "1000000",
        validAfter: 0,
        validBefore: 1,
        nonce: `0x${"11".repeat(32)}`,
      })
    ).rejects.toBeInstanceOf(PolicyBlockedError);
  });
});

describe("signMppProof", () => {
  beforeEach(() => {
    process.env.TURNKEY_API_PUBLIC_KEY = "test-pub";
    process.env.TURNKEY_API_PRIVATE_KEY = "test-priv";
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    mockSignRawPayload.mockReset();
    mockSignRawPayload.mockResolvedValue(happyPathResult("00"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("serialises typed data with chainId 4217 and primaryType Proof (Tempo proof-mode)", async () => {
    await signMppProof(SUB_ORG, WALLET, {
      chainId: 4217,
      challengeId: "challenge-abc-123",
    });
    const args = mockSignRawPayload.mock.calls[0]?.[0];
    expect(args.encoding).toBe("PAYLOAD_ENCODING_EIP712");
    const typedData = JSON.parse(args.payload) as {
      domain: { chainId: number };
      primaryType: string;
    };
    expect(typedData.domain.chainId).toBe(4217);
    expect(typedData.primaryType).toBe("Proof");
  });

  it("returns a 0x-prefixed 132-char signature for a Tempo proof", async () => {
    const sig = await signMppProof(SUB_ORG, WALLET, {
      chainId: 4217,
      challengeId: "challenge-abc-123",
    });
    expect(sig.startsWith("0x")).toBe(true);
    expect(sig.length).toBe(132);
  });
});
