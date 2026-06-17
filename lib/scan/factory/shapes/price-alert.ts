/**
 * Price/balance threshold-alert workflow shape.
 *
 * Topology: Schedule trigger -> check-token-balance -> Condition (balance < threshold) -> HTTP alert
 *
 * Polls every 15 minutes and alerts when a token balance drops below a
 * user-configured threshold. Phase 53 confirm screen populates walletAddress,
 * tokenAddress, and alertThreshold before saving.
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
const PRICE_ALERT_CRON = "*/15 * * * *";

// ---------------------------------------------------------------------------
// Shape builder
// ---------------------------------------------------------------------------

export interface PriceAlertOutput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Build the price/balance threshold-alert workflow shape.
 *
 * Checks the ERC20 token balance on-chain and alerts when the balance falls
 * below a user-specified threshold, prompting the user to top up or act.
 *
 * Node IDs are derived from the descriptor slug for determinism (PREFILL-03).
 * config.network is set to String(chainId) on all web3 nodes (PREFILL-04).
 *
 * The descriptor is expected to carry:
 *   - chainId: number (e.g. 42161 for Arbitrum)
 *   - confirmInputs.walletAddress: placeholder shown on Phase 53 confirm screen
 *   - confirmInputs.tokenAddress: ERC20 contract address placeholder
 *   - confirmInputs.alertThreshold: balance threshold placeholder
 */
export function buildPriceAlert(
  descriptor: SuggestionDescriptor
): PriceAlertOutput {
  const slug = descriptor.id;
  const network = String(descriptor.chainId);

  // Node IDs: ${slug}-${role} (PREFILL-03)
  const triggerId = `${slug}-trigger`;
  const readId = `${slug}-read`;
  const conditionId = `${slug}-condition`;
  const alertId = `${slug}-alert`;

  // Template ref for the raw balance output field from check-token-balance
  const balanceRef = `{{@${readId}:Check Token Balance.balance.balanceRaw}}`;

  // tokenConfig: JSON string describing the token selection.
  // Uses "custom" mode so Phase 53 can render a token picker.
  const tokenConfig = JSON.stringify({
    mode: "custom",
    customToken: {
      // Placeholder: Phase 53 confirm screen populates the real token address
      address: "{{tokenAddress}}",
      symbol: "TOKEN",
    },
  });

  const nodes: WorkflowNode[] = [
    buildScheduleTrigger(triggerId, { cron: PRICE_ALERT_CRON }, 0),
    buildCheckTokenBalanceNode(
      readId,
      {
        label: "Check Token Balance",
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
        label: "Balance Below Threshold",
        slug,
        leftOperand: balanceRef,
        operator: "<",
        // Placeholder replaced by the user's threshold in Phase 53
        rightOperand: "{{alertThreshold}}",
      },
      2
    ),
    buildHttpAlertNode(
      alertId,
      {
        label: "Send Price Alert",
        bodyTemplate: JSON.stringify({
          message: `Token balance below threshold: ${balanceRef}`,
        }),
      },
      3
    ),
  ];

  const edges: WorkflowEdge[] = [
    buildEdge(triggerId, readId),
    buildEdge(readId, conditionId),
    // Condition true-branch: alert fires when balance < threshold
    buildEdge(conditionId, alertId, "true"),
  ];

  return { nodes, edges };
}
