/**
 * Stablecoin idle yield monitor workflow shape.
 *
 * Topology: Schedule trigger → check-token-balance → Condition (balance > 0) → HTTP alert
 *
 * Read-only — uses only read action types so validateWorkflow with
 * workflowType "read" produces zero errors and zero warnings (PREFILL-06).
 *
 * Requirements: PREFILL-01, PREFILL-03, PREFILL-04, PREFILL-05, PREFILL-06
 */

import {
  buildCheckTokenBalanceNode,
  buildConditionNode,
  buildEdge,
  buildHttpAlertNode,
  buildScheduleTrigger,
} from "@/lib/scan/factory/node-builders";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Schedule defaults
// ---------------------------------------------------------------------------

/** Poll every 15 minutes — well above the 60s floor (PREFILL-05). */
const YIELD_MONITOR_CRON = "*/15 * * * *";

// ---------------------------------------------------------------------------
// Shape builder
// ---------------------------------------------------------------------------

export interface StablecoinYieldOutput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Build the stablecoin idle yield monitor workflow shape.
 *
 * Checks the ERC20 token balance on-chain and alerts when a balance exists,
 * prompting the user to consider deploying idle stablecoin to a yield protocol.
 *
 * Node IDs are derived from the descriptor slug for determinism (PREFILL-03).
 * config.network is set to String(chainId) on all web3 nodes (PREFILL-04).
 *
 * The descriptor is expected to carry:
 *   - chainId: number (e.g. 42161 for Arbitrum)
 *   - confirmInputs.walletAddress: placeholder text shown on Phase 53 confirm screen
 *
 * The tokenConfig is built from the descriptor id to derive a custom token
 * reference. Phase 53 confirm screen allows the user to select the actual token.
 */
export function buildStablecoinYield(
  descriptor: SuggestionDescriptor
): StablecoinYieldOutput {
  const slug = descriptor.id;
  const network = String(descriptor.chainId);

  // Node IDs: ${slug}-${role} (PREFILL-03)
  const triggerId = `${slug}-trigger`;
  const readId = `${slug}-read`;
  const conditionId = `${slug}-condition`;
  const alertId = `${slug}-alert`;

  // Template ref for the raw balance output field
  const balanceRef = `{{@${readId}:Get ERC20 Token Balance.balance.balanceRaw}}`;

  // tokenConfig: JSON string describing the token selection.
  // Uses "custom" mode so Phase 53 can render a token picker.
  const tokenConfig = JSON.stringify({
    mode: "custom",
    customToken: {
      // Placeholder: Phase 53 confirm screen populates the real token address
      address: "{{tokenAddress}}",
      symbol: "STABLECOIN",
    },
  });

  const nodes: WorkflowNode[] = [
    buildScheduleTrigger(triggerId, { cron: YIELD_MONITOR_CRON }, 0),
    buildCheckTokenBalanceNode(
      readId,
      {
        label: "Get ERC20 Token Balance",
        network,
        // Placeholder replaced by the user's wallet address in Phase 53
        address: "{{walletAddress}}",
        tokenConfig,
      },
      1
    ),
    buildConditionNode(
      conditionId,
      {
        label: "Balance Above Zero",
        slug,
        leftOperand: balanceRef,
        operator: ">",
        rightOperand: "0",
      },
      2
    ),
    buildHttpAlertNode(
      alertId,
      {
        label: "Send Yield Alert",
        bodyTemplate: JSON.stringify({
          message: `Idle stablecoin balance detected: ${balanceRef}. Consider deploying to a yield protocol.`,
        }),
      },
      3
    ),
  ];

  const edges: WorkflowEdge[] = [
    buildEdge(triggerId, readId),
    buildEdge(readId, conditionId),
    // Condition true-branch: alert fires when balance > 0
    buildEdge(conditionId, alertId, "true"),
  ];

  return { nodes, edges };
}
