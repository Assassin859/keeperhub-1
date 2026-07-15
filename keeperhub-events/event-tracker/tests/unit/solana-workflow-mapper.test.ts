import { describe, expect, it } from "vitest";
import type { NetworkConfig, NetworksMap } from "../../lib/types";
import type { SolanaWorkflowRegistration } from "../../src/listener/registry";
import {
  buildRegistration,
  hashSolanaRegistration,
} from "../../src/listener/workflow-mapper";

const CHAIN_ID = 103;
// SPL Token program - a real, valid base58 program address.
const PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const NETWORK: NetworkConfig = {
  id: "sol-devnet",
  chainId: CHAIN_ID,
  name: "Solana Devnet",
  symbol: "SOL",
  chainType: "solana",
  defaultPrimaryRpc: "https://api.devnet.solana.com",
  defaultFallbackRpc: "https://fallback.devnet.example.com",
  defaultPrimaryWss: "wss://api.devnet.solana.com",
  defaultFallbackWss: "wss://fallback.devnet.example.com",
  isTestnet: true,
  isEnabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const NETWORKS: NetworksMap = { [CHAIN_ID]: NETWORK };

function makeWorkflow(
  overrides: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "wf-sol",
    name: "Solana Event Workflow",
    userId: "user-1",
    nodes: [
      {
        data: {
          config: {
            network: String(CHAIN_ID),
            programId: PROGRAM_ID,
            ...configOverrides,
          },
        },
      },
    ],
    ...overrides,
  };
}

function asSolana(
  reg: ReturnType<typeof buildRegistration>,
): SolanaWorkflowRegistration {
  expect(reg).not.toBeNull();
  if (!reg || reg.kind !== "solana") {
    throw new Error("expected a solana registration");
  }
  return reg;
}

describe("buildRegistration (Solana branch)", () => {
  it("maps a valid Solana workflow into a SolanaWorkflowRegistration", () => {
    const reg = asSolana(buildRegistration(makeWorkflow(), NETWORKS));
    expect(reg).toMatchObject({
      kind: "solana",
      workflowId: "wf-sol",
      userId: "user-1",
      workflowName: "Solana Event Workflow",
      chainId: CHAIN_ID,
      rpcUrl: "https://api.devnet.solana.com",
      fallbackRpcUrl: "https://fallback.devnet.example.com",
      wssUrl: "wss://api.devnet.solana.com",
      fallbackWssUrl: "wss://fallback.devnet.example.com",
      programId: PROGRAM_ID,
      commitment: "confirmed",
    });
    expect(reg.idl).toBeUndefined();
    expect(reg.eventName).toBeUndefined();
    expect(reg.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("defaults commitment to confirmed and honours a valid override", () => {
    expect(
      asSolana(buildRegistration(makeWorkflow(), NETWORKS)).commitment,
    ).toBe("confirmed");
    expect(
      asSolana(
        buildRegistration(
          makeWorkflow({}, { commitment: "finalized" }),
          NETWORKS,
        ),
      ).commitment,
    ).toBe("finalized");
  });

  it("falls back to confirmed for an invalid commitment", () => {
    const reg = asSolana(
      buildRegistration(makeWorkflow({}, { commitment: "bogus" }), NETWORKS),
    );
    expect(reg.commitment).toBe("confirmed");
  });

  it("carries idl and eventName through when present (typed mode)", () => {
    const reg = asSolana(
      buildRegistration(
        makeWorkflow({}, { idl: '{"events":[]}', eventName: "Deposited" }),
        NETWORKS,
      ),
    );
    expect(reg.idl).toBe('{"events":[]}');
    expect(reg.eventName).toBe("Deposited");
  });

  it("returns null when programId is missing", () => {
    expect(
      buildRegistration(makeWorkflow({}, { programId: undefined }), NETWORKS),
    ).toBeNull();
  });

  it("returns null when programId is not valid base58", () => {
    expect(
      buildRegistration(
        makeWorkflow({}, { programId: "not-a-real-key" }),
        NETWORKS,
      ),
    ).toBeNull();
  });

  it("returns null when defaultPrimaryRpc is missing", () => {
    const networks: NetworksMap = {
      [CHAIN_ID]: { ...NETWORK, defaultPrimaryRpc: "" },
    };
    expect(buildRegistration(makeWorkflow(), networks)).toBeNull();
  });

  it("returns null when defaultPrimaryWss is missing (needed for slot sub)", () => {
    const networks: NetworksMap = {
      [CHAIN_ID]: { ...NETWORK, defaultPrimaryWss: "" },
    };
    expect(buildRegistration(makeWorkflow(), networks)).toBeNull();
  });

  it("returns null when defaultPrimaryWss is an HTTP URL", () => {
    const networks: NetworksMap = {
      [CHAIN_ID]: {
        ...NETWORK,
        defaultPrimaryWss: "https://api.devnet.solana.com",
      },
    };
    expect(buildRegistration(makeWorkflow(), networks)).toBeNull();
  });

  it("drops an invalid fallback wss but keeps the workflow on primary", () => {
    const networks: NetworksMap = {
      [CHAIN_ID]: {
        ...NETWORK,
        defaultFallbackWss: "https://bad-scheme.example.com",
      },
    };
    const reg = asSolana(buildRegistration(makeWorkflow(), networks));
    expect(reg.fallbackWssUrl).toBeUndefined();
  });

  describe("configHash", () => {
    it("is stable across identical inputs and ignores workflowName", () => {
      const a = asSolana(buildRegistration(makeWorkflow(), NETWORKS));
      const b = asSolana(
        buildRegistration(makeWorkflow({ name: "Other" }), NETWORKS),
      );
      expect(a.configHash).toBe(b.configHash);
    });

    it("matches hashSolanaRegistration recomputed from the fields", () => {
      const reg = asSolana(buildRegistration(makeWorkflow(), NETWORKS));
      expect(hashSolanaRegistration(reg)).toBe(reg.configHash);
    });

    it("changes when programId changes", () => {
      const a = asSolana(buildRegistration(makeWorkflow(), NETWORKS));
      const b = asSolana(
        buildRegistration(
          makeWorkflow({}, { programId: "11111111111111111111111111111111" }),
          NETWORKS,
        ),
      );
      expect(a.configHash).not.toBe(b.configHash);
    });

    it("changes when commitment, idl, or eventName change", () => {
      const base = asSolana(buildRegistration(makeWorkflow(), NETWORKS));
      const byCommitment = asSolana(
        buildRegistration(
          makeWorkflow({}, { commitment: "finalized" }),
          NETWORKS,
        ),
      );
      const byIdl = asSolana(
        buildRegistration(makeWorkflow({}, { idl: '{"events":[]}' }), NETWORKS),
      );
      const byEvent = asSolana(
        buildRegistration(
          makeWorkflow({}, { eventName: "Deposited" }),
          NETWORKS,
        ),
      );
      expect(byCommitment.configHash).not.toBe(base.configHash);
      expect(byIdl.configHash).not.toBe(base.configHash);
      expect(byEvent.configHash).not.toBe(base.configHash);
    });

    it("changes when userId changes", () => {
      const a = asSolana(buildRegistration(makeWorkflow(), NETWORKS));
      const b = asSolana(
        buildRegistration(makeWorkflow({ userId: "user-2" }), NETWORKS),
      );
      expect(a.configHash).not.toBe(b.configHash);
    });
  });
});
