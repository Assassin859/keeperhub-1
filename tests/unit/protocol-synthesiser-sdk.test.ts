import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { generateWorkflowSDKCode } = await import("@/lib/workflow/codegen/sdk");

import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

const triggerNode: WorkflowNode = {
  id: "trigger-1",
  type: "trigger",
  position: { x: 0, y: 0 },
  data: {
    type: "trigger",
    label: "Manual Trigger",
    config: { triggerType: "Manual" },
  },
};

function ccipBalanceNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: "Check CCIP Balance",
      config: {
        actionType: "chainlink/ccip-check-bridge-balance",
        network: "11155111",
        contractAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
        account: "0x1111111111111111111111111111111111111111",
      },
    },
  };
}

const edge = (s: string, t: string): WorkflowEdge => ({
  id: `${s}-${t}`,
  source: s,
  target: t,
});

describe("generateWorkflowSDKCode (protocol synthesis path)", () => {
  it("emits viem imports and inlines the synthesised body for a CCIP balance node", () => {
    const node = ccipBalanceNode("a-1");
    const code = generateWorkflowSDKCode(
      "ccip_balance_workflow",
      [triggerNode, node],
      [edge(triggerNode.id, node.id)]
    );

    process.stdout.write("\n=== SDK OUTPUT ===\n");
    process.stdout.write(`${code}\n`);

    expect(code).toContain('import { createPublicClient, http } from "viem"');
    expect(code).toContain('import { sepolia } from "viem/chains"');
    expect(code).toContain(
      'const CONTRACT_ADDRESS = "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05" as const;'
    );
    expect(code).toContain('functionName: "balanceOf"');
    // Body should reference stepInput.X (rebound from input.X by SDK helper)
    expect(code).toContain("args: [stepInput.account]");
    // stepInput should be constructed from config
    expect(code).toContain(
      "account: `0x1111111111111111111111111111111111111111`"
    );
    // Must not be the legacy stub
    expect(code).not.toContain("return { success: true };\n}");
  });

  it("namespaces nothing -- two CCIP balance nodes would collide on CONTRACT_ADDRESS", () => {
    // Documenting the known limitation: constants are scoped inside each
    // step function (not at file top), so two CCIP nodes get independent
    // CONTRACT_ADDRESS bindings without colliding.
    const node1 = ccipBalanceNode("a-1");
    const node2 = ccipBalanceNode("a-2");
    const code = generateWorkflowSDKCode(
      "two_balances",
      [triggerNode, node1, node2],
      [edge(triggerNode.id, node1.id), edge(node1.id, node2.id)]
    );

    // Each step function inlines its own CONTRACT_ADDRESS const
    const occurrences = code.match(/const CONTRACT_ADDRESS =/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});
