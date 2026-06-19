import { and, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { classifyExecutionError } from "@/lib/errors/classify";
import { statusForErrorType } from "@/lib/errors/execution-status";
import { recordExecutionErrorFinalized } from "@/lib/errors/finalize-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { executeWorkflow } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

type BackgroundLogContext = {
  /** Prefix for console logs, e.g. "[Workflow Execute]" or "[Webhook]". */
  logPrefix: string;
  /** Route path recorded on error logs. */
  endpoint: string;
};

/**
 * Fire-and-forget workflow kick-off shared by the execute and webhook routes.
 * Both routes pre-create the `workflow_executions` row, then call this to start
 * the DevKit run and persist the resulting runId. The terminal success status
 * is written from inside `executeWorkflow` (its `_workflowComplete` step), not
 * here - this only records the failure path when `start()` itself throws.
 *
 * SECURITY: only the workflowId is passed as a reference; steps fetch
 * credentials internally so secrets never reach observability output.
 */
export async function executeWorkflowInBackground(
  executionId: string,
  workflowId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  input: Record<string, unknown>,
  context: BackgroundLogContext,
  organizationId?: string | null,
  createdBy?: string,
  organizationSlug?: string,
  organizationPlan?: string
): Promise<void> {
  try {
    console.log(`${context.logPrefix} Starting execution:`, executionId);

    // Flip the pre-created row from "pending" to "running" so every execution
    // path shares the same pending -> running -> terminal lifecycle. Guarded on
    // the current status so a fast run that already wrote a terminal status is
    // never clobbered back to running.
    await db
      .update(workflowExecutions)
      .set({ status: "running" })
      .where(
        and(
          eq(workflowExecutions.id, executionId),
          eq(workflowExecutions.status, "pending")
        )
      );

    const run = await start(executeWorkflow, [
      {
        nodes,
        edges,
        triggerInput: input,
        executionId,
        workflowId,
        organizationId: organizationId ?? undefined,
        createdBy,
        organizationSlug,
        organizationPlan,
      },
    ]);

    console.log(`${context.logPrefix} Workflow started, runId:`, run.runId);

    await db
      .update(workflowExecutions)
      .set({ runId: run.runId })
      .where(eq(workflowExecutions.id, executionId));
  } catch (error) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      `${context.logPrefix} Error during execution`,
      error,
      { endpoint: context.endpoint, operation: "executeWorkflow" }
    );

    // KEEP-545: classify the error so the row carries error_category and
    // error_type and so the per-execution counter is incremented post-update.
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const classification = classifyExecutionError(errorMessage);

    const updated = await db
      .update(workflowExecutions)
      .set({
        status: statusForErrorType(classification.errorType),
        error: errorMessage,
        errorCategory: classification.errorCategory,
        errorType: classification.errorType,
        errorCode: classification.code,
        completedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, executionId))
      .returning({ workflowId: workflowExecutions.workflowId });

    if (updated.length > 0) {
      await recordExecutionErrorFinalized({
        workflowId: updated[0].workflowId,
        errorMessage,
      });
    }
  }
}
