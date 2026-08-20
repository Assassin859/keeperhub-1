import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockDbSelect = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

const mockGetChainIdFromNetwork = vi.fn();
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

const mockGetSignaturesForAddress = vi.fn();
const mockGetTransaction = vi.fn();
const fakeConnection = {
  getSignaturesForAddress: (...args: unknown[]) =>
    mockGetSignaturesForAddress(...args),
  getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
};
const mockExecuteWithFailover = vi.fn((operation: (c: unknown) => unknown) =>
  Promise.resolve(operation(fakeConnection))
);
const mockGetSolanaProvider = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getSolanaProvider: (...args: unknown[]) => mockGetSolanaProvider(...args),
}));

import {
  DEFAULT_SIGNATURE_LOOKBACK,
  MAX_SIGNATURE_PAGES,
  MAX_SIGNATURES_PER_PAGE,
  queryProgramEventsCore,
} from "@/plugins/web3/steps/query-solana-program-events-core";

const PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const DISCRIMINATOR = [11, 22, 33, 44, 55, 66, 77, 88];
const IDL: Idl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "test_program", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [],
  events: [{ name: "Deposited", discriminator: DISCRIMINATOR }],
  types: [
    {
      name: "Deposited",
      type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] },
    },
  ],
};

function anchorEventLog(amount: number): string {
  const coder = new BorshCoder(IDL);
  const encoded = coder.types.encode("Deposited", { amount: new BN(amount) });
  const blob = Buffer.concat([Buffer.from(DISCRIMINATOR), encoded]);
  return `Program data: ${blob.toString("base64")}`;
}

function sigInfo(
  signature: string,
  slot: number,
  overrides: Partial<{ err: unknown }> = {}
): {
  signature: string;
  slot: number;
  err: unknown;
  memo: null;
  blockTime: number;
  confirmationStatus: string;
} {
  return {
    signature,
    slot,
    err: overrides.err ?? null,
    memo: null,
    blockTime: 1_700_000_000,
    confirmationStatus: "finalized",
  };
}

describe("queryProgramEventsCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChainIdFromNetwork.mockReturnValue(101);
    mockGetSolanaProvider.mockResolvedValue({
      executeWithFailover: mockExecuteWithFailover,
    });
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    });
  });

  it("rejects an invalid program id before making any RPC call", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: "not-a-valid-pubkey",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects an eventName filter when no valid IDL is supplied", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      eventName: "Deposited",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("returns an empty result when the program has no signatures", async () => {
    mockGetSignaturesForAddress.mockResolvedValue([]);

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(result).toEqual({
      success: true,
      events: [],
      oldestSignature: null,
      newestSignature: null,
      signatureCount: 0,
      eventCount: 0,
      truncated: false,
      nextBeforeSignature: null,
    });
  });

  it("decodes matching events against the provided Anchor IDL", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([
      sigInfo("sig-newest", 20),
      sigInfo("sig-oldest", 10),
    ]);
    mockGetTransaction.mockImplementation((signature: string) =>
      Promise.resolve({
        meta: {
          logMessages: [
            "Program log: instruction: deposit",
            anchorEventLog(signature === "sig-newest" ? 2 : 1),
          ],
        },
      })
    );

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      idl: JSON.stringify(IDL),
      eventName: "Deposited",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toHaveLength(2);
    // Oldest-first ordering in the output, matching on-chain order.
    expect(result.events[0].signature).toBe("sig-oldest");
    expect(result.events[0].eventName).toBe("Deposited");
    expect(String(result.events[0].args?.amount)).toBe("1");
    expect(result.events[1].signature).toBe("sig-newest");
    expect(result.oldestSignature).toBe("sig-oldest");
    expect(result.newestSignature).toBe("sig-newest");
    expect(result.truncated).toBe(false);
  });

  it("returns raw log lines when no IDL is supplied", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([sigInfo("sig-1", 5)]);
    mockGetTransaction.mockResolvedValue({
      meta: { logMessages: ["Program log: raw entry"] },
    });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toEqual([
      {
        signature: "sig-1",
        slot: 5,
        blockTime: 1_700_000_000,
        raw: ["Program log: raw entry"],
      },
    ]);
  });

  it("skips failed transactions without fetching them", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([
      sigInfo("sig-failed", 5, { err: { InstructionError: [0, "Custom"] } }),
    ]);

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toEqual([]);
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it("marks the result truncated and returns a resume cursor when the page cap is hit", async () => {
    const fullPage = Array.from({ length: MAX_SIGNATURES_PER_PAGE }, (_, i) =>
      sigInfo(`sig-${i}`, i)
    );
    mockGetSignaturesForAddress.mockResolvedValue(fullPage);
    mockGetTransaction.mockResolvedValue({ meta: { logMessages: [] } });

    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: MAX_SIGNATURES_PER_PAGE * MAX_SIGNATURE_PAGES,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(mockGetSignaturesForAddress).toHaveBeenCalledTimes(
      MAX_SIGNATURE_PAGES
    );
    expect(result.truncated).toBe(true);
    expect(result.nextBeforeSignature).toBe(result.oldestSignature);
  });

  it("rejects an invalid signatureLookback value", async () => {
    const result = await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
      signatureLookback: "not-a-number",
    });

    expect(result.success).toBe(false);
    expect(mockGetSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("defaults signatureLookback when unset", async () => {
    mockGetSignaturesForAddress.mockResolvedValueOnce([]);

    await queryProgramEventsCore({
      network: "solana",
      programId: PROGRAM_ID,
    });

    expect(mockGetSignaturesForAddress).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: DEFAULT_SIGNATURE_LOOKBACK })
    );
  });
});
