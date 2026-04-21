import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";

/**
 * Default timeout for waiting on read-workflow completion before falling back
 * to the async `{executionId, status: "running"}` response. Kept under typical
 * HTTP/MCP client timeouts (~30s) so clients don't time out on us.
 */
export const DEFAULT_CALL_WAIT_TIMEOUT_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

type TerminalStatus = "success" | "error" | "cancelled";

type ExecutionResult = {
  status: TerminalStatus;
  output: unknown;
  error: string | null;
};

/**
 * Poll workflowExecutions.status until it reaches a terminal state (success,
 * error, cancelled) or the timeout elapses. Returns null on timeout.
 */
export async function waitForExecutionCompletion(
  executionId: string,
  timeoutMs: number = DEFAULT_CALL_WAIT_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
): Promise<ExecutionResult | null> {
  if (timeoutMs <= 0) {
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const row = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      columns: { status: true, output: true, error: true },
    });
    if (!row) {
      return null;
    }
    if (
      row.status === "success" ||
      row.status === "error" ||
      row.status === "cancelled"
    ) {
      return {
        status: row.status,
        output: row.output,
        error: row.error ?? null,
      };
    }
    if (Date.now() + pollIntervalMs >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Resolve the payload returned inline to the caller for a completed read
 * workflow. outputMapping shape is `{ nodeId?: string, fields?: string[] }`:
 *   - If nodeId is set, fetch that node's successful log output.
 *   - If fields is set, pick only those keys from the node output.
 *   - Otherwise, return the workflow-level output as-is.
 */
export async function applyOutputMapping(
  executionId: string,
  workflowOutput: unknown,
  outputMapping: Record<string, unknown> | null | undefined
): Promise<unknown> {
  if (!outputMapping || typeof outputMapping !== "object") {
    return workflowOutput;
  }
  const mapping = outputMapping as { nodeId?: unknown; fields?: unknown };
  const nodeId = typeof mapping.nodeId === "string" ? mapping.nodeId : null;
  if (!nodeId) {
    return workflowOutput;
  }

  const log = await db.query.workflowExecutionLogs.findFirst({
    where: and(
      eq(workflowExecutionLogs.executionId, executionId),
      eq(workflowExecutionLogs.nodeId, nodeId),
      eq(workflowExecutionLogs.status, "success")
    ),
    orderBy: [desc(workflowExecutionLogs.completedAt)],
  });
  const nodeOutput = log?.output ?? workflowOutput;

  if (
    Array.isArray(mapping.fields) &&
    mapping.fields.length > 0 &&
    nodeOutput &&
    typeof nodeOutput === "object"
  ) {
    const picked: Record<string, unknown> = {};
    for (const field of mapping.fields) {
      if (typeof field === "string") {
        picked[field] = (nodeOutput as Record<string, unknown>)[field];
      }
    }
    return picked;
  }
  return nodeOutput;
}

export type CallCompletionResponse =
  | { executionId: string; status: "success"; output: unknown }
  | { executionId: string; status: "error"; error: string }
  | { executionId: string; status: "running" };

/**
 * Wait for the read-workflow execution to complete, then build the response
 * payload. On timeout, returns `{status: "running"}` so clients can fall back
 * to polling the existing status/logs endpoints.
 */
export async function buildCallCompletionResponse(
  executionId: string,
  outputMapping: Record<string, unknown> | null | undefined,
  timeoutMs: number = DEFAULT_CALL_WAIT_TIMEOUT_MS
): Promise<CallCompletionResponse> {
  const result = await waitForExecutionCompletion(executionId, timeoutMs);
  if (!result) {
    return { executionId, status: "running" };
  }
  if (result.status === "success") {
    const output = await applyOutputMapping(
      executionId,
      result.output,
      outputMapping
    );
    return { executionId, status: "success", output };
  }
  if (result.status === "cancelled") {
    return { executionId, status: "error", error: "Execution cancelled" };
  }
  return {
    executionId,
    status: "error",
    error: result.error ?? "Execution failed",
  };
}
