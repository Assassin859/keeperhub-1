import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const spies = vi.hoisted(() => ({
  simulateContractCall: vi.fn(),
  simulateNativeTransfer: vi.fn(),
  simulateTokenTransfer: vi.fn(),
  getChainIdFromNetwork: vi.fn(),
  isSolanaChain: vi.fn(),
  resolveSignerForNode: vi.fn(),
}));

vi.mock("@/lib/execute/simulate", () => ({
  simulateContractCall: spies.simulateContractCall,
  simulateNativeTransfer: spies.simulateNativeTransfer,
  simulateTokenTransfer: spies.simulateTokenTransfer,
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: spies.getChainIdFromNetwork,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  isSolanaChain: spies.isSolanaChain,
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: {
    EOA: "eoa",
    SAFE: "safe",
    SAFE_ROLE: "safe-role",
  },
  parseWeb3Connection: (value?: string | null) => {
    if (!value || value === "default") {
      return { kind: "default" };
    }
    if (value === "eoa") {
      return { kind: "eoa" };
    }
    if (value.startsWith("safe:") && value.length > "safe:".length) {
      return { kind: "safe", safeWalletId: value.slice("safe:".length) };
    }
    throw new Error(`Invalid web3Connection value '${value}'`);
  },
  resolveSignerForNode: spies.resolveSignerForNode,
}));

import {
  runWorkflowSimulation,
  type WorkflowSimulationNode,
} from "@/lib/workflow/run-simulation";

const SUCCESS_RESULT = {
  success: true,
  status: "simulated" as const,
  from: "0xaa0000000000000000000000000000000000aa00",
  to: "0xbb0000000000000000000000000000000000bb00",
  value: "0",
  gasEstimate: "21000",
  simulatedReturnValue: null,
  wouldRevert: false as const,
};

function actionNode(
  id: string,
  actionType: string,
  config: Record<string, unknown> = {},
  options?: { enabled?: boolean; label?: string }
): WorkflowSimulationNode {
  return {
    id,
    type: "action",
    data: {
      type: "action",
      enabled: options?.enabled,
      label: options?.label ?? actionType,
      config: {
        actionType,
        network: "1",
        web3Connection: "eoa",
        ...config,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.getChainIdFromNetwork.mockReturnValue(1);
  spies.isSolanaChain.mockReturnValue(false);
  spies.resolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xaa0000000000000000000000000000000000aa00",
  });
  spies.simulateContractCall.mockResolvedValue(SUCCESS_RESULT);
  spies.simulateNativeTransfer.mockResolvedValue(SUCCESS_RESULT);
  spies.simulateTokenTransfer.mockResolvedValue(SUCCESS_RESULT);
});

describe("runWorkflowSimulation", () => {
  it("simulates a static EOA native transfer", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "0.1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result).toEqual({
      errors: [],
      warnings: [],
      simulatedNodeCount: 1,
      skippedNodeCount: 0,
    });

    expect(spies.simulateNativeTransfer).toHaveBeenCalledWith({
      organizationId: "org_test",
      network: "1",
      amount: "0.1",
      recipientAddress: "0xbb0000000000000000000000000000000000bb00",
    });
  });

  it("turns a confirmed revert into a blocking node issue", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "100",
      failureKind: "revert",
      wouldRevert: true,
      revertReason: "InsufficientBalance()",
      error: "InsufficientBalance()",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode(
          "transfer-1",
          "web3/transfer-funds",
          {
            amount: "100",
            recipientAddress: "0xbb0000000000000000000000000000000000bb00",
          },
          { label: "Pay supplier" }
        ),
      ],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "SIMULATION_WOULD_REVERT",
      nodeId: "transfer-1",
      fieldKey: "amount",
      parameterPath: "nodes[0].data.config.amount",
    });
    expect(result.errors[0]?.message).toBe(
      "Pay supplier would revert: InsufficientBalance()"
    );
    expect(result.errors[0]?.message).not.toContain("CALL_EXCEPTION");
    expect(result.errors[0]?.message).not.toContain("transaction={");
    expect(result.warnings).toEqual([]);
  });

  it("preserves a useful decoded revert reason and uses a readable action name", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "100",
      failureKind: "revert",
      wouldRevert: true,
      revertReason: "InsufficientBalance()",
      error: "InsufficientBalance()",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "100",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe(
      "Transfer Native Token would revert: InsufficientBalance()"
    );
  });

  it("replaces raw ethers revert details with actionable guidance", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "100",
      failureKind: "revert",
      wouldRevert: true,
      revertReason:
        'Simulation failed: missing revert data (action="estimateGas", transaction={"from":"0xaa"}, code=CALL_EXCEPTION)',
      error:
        'Simulation failed: missing revert data (action="estimateGas", transaction={"from":"0xaa"}, code=CALL_EXCEPTION)',
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "100",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe(
      "Transfer Native Token would revert. Check the wallet balance, amount, recipient, and gas requirements."
    );
    expect(result.errors[0]?.message).not.toContain("missing revert data");
    expect(result.errors[0]?.message).not.toContain("CALL_EXCEPTION");
    expect(result.errors[0]?.message).not.toContain("transaction=");
  });

  it("turns RPC unavailability into a non-blocking warning", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "100",
      failureKind: "unavailable",
      wouldRevert: false,
      error: "Simulation unavailable: RPC timeout",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "100",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_UNAVAILABLE",
      nodeId: "transfer-1",
      fieldKey: "network",
      parameterPath: "nodes[0].data.config.network",
      message:
        "Transfer Native Token could not be simulated because the RPC service was unavailable. You can still run the workflow.",
    });
    expect(result.warnings[0]?.message).not.toContain(
      "All RPC providers failed"
    );
    expect(result.skippedNodeCount).toBe(1);
  });

  it("does not simulate a node whose transaction depends on runtime templates", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "{{Get Amount.value}}",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_DYNAMIC_INPUT",
      fieldKey: "amount",
      nodeId: "transfer-1",
    });
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("does not simulate an explicitly Safe-routed write", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
          web3Connection: "safe:safe_wallet_1",
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("SIMULATION_SAFE_SIGNER_UNSUPPORTED");
    expect(spies.resolveSignerForNode).not.toHaveBeenCalled();
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("does not simulate an EVM-only preflight on Solana", async () => {
    spies.getChainIdFromNetwork.mockReturnValueOnce(101);
    spies.isSolanaChain.mockReturnValueOnce(true);

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          network: "101",
          amount: "1",
          recipientAddress: "SolanaRecipient",
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings[0]?.code).toBe("SIMULATION_UNSUPPORTED_CHAIN");
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("skips disabled and unsupported action nodes silently", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode(
          "disabled-transfer",
          "web3/transfer-funds",
          {
            amount: "1",
            recipientAddress: "0xbb0000000000000000000000000000000000bb00",
          },
          { enabled: false }
        ),
        actionNode("email-1", "email/send-email"),
      ],
    });

    expect(result).toEqual({
      errors: [],
      warnings: [],
      simulatedNodeCount: 0,
      skippedNodeCount: 0,
    });
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("maps a write-contract node to simulateContractCall", async () => {
    const abi = [
      {
        type: "function",
        name: "setValue",
        stateMutability: "nonpayable",
        inputs: [{ name: "value", type: "uint256" }],
        outputs: [],
      },
    ];

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("write-1", "web3/write-contract", {
          contractAddress: "0xbb0000000000000000000000000000000000bb00",
          abi,
          abiFunction: "setValue",
          functionArgs: ["123"],
          ethValue: "0",
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.simulatedNodeCount).toBe(1);
    expect(spies.simulateContractCall).toHaveBeenCalledWith({
      organizationId: "org_test",
      network: "1",
      contractAddress: "0xbb0000000000000000000000000000000000bb00",
      abi: JSON.stringify(abi),
      functionName: "setValue",
      functionArgs: JSON.stringify(["123"]),
      value: "0",
    });
  });

  it("supports the legacy functionName field on write-contract nodes", async () => {
    const abi = [
      {
        type: "function",
        name: "setValue",
        stateMutability: "nonpayable",
        inputs: [{ name: "value", type: "uint256" }],
        outputs: [],
      },
    ];

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("write-legacy", "web3/write-contract", {
          contractAddress: "0xbb0000000000000000000000000000000000bb00",
          abi,
          functionName: "setValue",
          functionArgs: ["123"],
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.simulatedNodeCount).toBe(1);
    expect(spies.simulateContractCall).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "setValue" })
    );
  });

  it("maps a token-transfer node to simulateTokenTransfer", async () => {
    const tokenConfig = {
      supportedTokenId: "usdc-mainnet",
    };

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("token-1", "web3/transfer-token", {
          tokenConfig,
          amount: "12.5",
          decimals: 6,
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.simulatedNodeCount).toBe(1);
    expect(spies.simulateTokenTransfer).toHaveBeenCalledWith({
      organizationId: "org_test",
      network: "1",
      tokenConfig: JSON.stringify(tokenConfig),
      tokenAddress: undefined,
      amount: "12.5",
      decimals: 6,
      recipientAddress: "0xbb0000000000000000000000000000000000bb00",
    });
  });
});
