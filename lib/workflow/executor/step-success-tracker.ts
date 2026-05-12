/**
 * KEEP-1541: In-memory tracker for step successes within a workflow execution.
 *
 * Both withStepLogging (step-handler.ts) and the workflow executor run in the
 * same Node.js process, so a module-level Map is sufficient. This replaces the
 * HTTP loopback approach that failed silently in production.
 *
 * Only successes are tracked. The reconciler treats a tracked success as proof
 * that the step completed, regardless of subsequent SDK retry errors. This is
 * safe because withStepLogging records success only after the step function
 * returns without error -- the "max retries exceeded" error originates from
 * the SDK's durability layer, not from the step itself.
 *
 * Lifecycle:
 *   1. withStepLogging calls recordStepSuccess() after each successful step
 *   2. The executor calls getSuccessfulSteps() during max-retries reconciliation
 *   3. The executor calls clearExecution() in a finally block to free memory
 */

import type { TransactionHashEntry } from "@/lib/db/schema";
import type { StepContext } from "./step-handler";

const executions = new Map<string, Map<string, unknown>>();
const txHashEntries = new Map<string, TransactionHashEntry[]>();

export function recordStepSuccess(
  executionId: string,
  nodeId: string,
  output: unknown
): void {
  let steps = executions.get(executionId);
  if (steps === undefined) {
    steps = new Map<string, unknown>();
    executions.set(executionId, steps);
  }
  steps.set(nodeId, output);
}

export function getSuccessfulSteps(
  executionId: string
): Map<string, unknown> | undefined {
  return executions.get(executionId);
}

/**
 * If the step output carries an on-chain transaction hash (0x-prefixed
 * string), append it to the per-execution ordered list along with the node
 * and chain context that produced it. Called from withStepLoggingInner after
 * each successful step.
 *
 * Optional fields (chainId, network, iterationIndex) are omitted from the
 * entry rather than set to null when not present in the output / context,
 * keeping the persisted JSON clean and making `if ("chainId" in entry)`
 * checks meaningful on the consumer side.
 */
export function recordTransactionHashIfPresent(
  context: StepContext,
  output: unknown
): void {
  if (context.executionId === undefined) {
    return;
  }
  const o = output as {
    transactionHash?: unknown;
    chainId?: unknown;
    network?: unknown;
  } | null;
  if (
    o === null ||
    typeof o !== "object" ||
    typeof o.transactionHash !== "string" ||
    !o.transactionHash.startsWith("0x")
  ) {
    return;
  }
  const entry: TransactionHashEntry = {
    hash: o.transactionHash,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    ...(typeof o.chainId === "number" && { chainId: o.chainId }),
    ...(typeof o.network === "string" && { network: o.network }),
    ...(typeof context.iterationIndex === "number" && {
      iterationIndex: context.iterationIndex,
    }),
  };
  const list = txHashEntries.get(context.executionId) ?? [];
  list.push(entry);
  txHashEntries.set(context.executionId, list);
}

/**
 * Returns a shallow copy of the tracked entries so callers cannot mutate
 * the internal list. resolveTransactionHashesForSuccess feeds this directly
 * into a DB UPDATE; without the copy, any future caller that mutates the
 * returned array (push, splice, reverse) would silently mutate the
 * tracker's state for the entire process lifetime of that execution.
 */
export function getTransactionHashes(
  executionId: string
): TransactionHashEntry[] {
  const list = txHashEntries.get(executionId);
  return list === undefined ? [] : [...list];
}

export function clearExecution(executionId: string): void {
  executions.delete(executionId);
  txHashEntries.delete(executionId);
}
