import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { and, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import {
  classifyExecutionError,
  isDefaultClassification,
} from "@/lib/errors/classify";
import { statusForErrorType } from "@/lib/errors/execution-status";
import { recordExecutionErrorFinalized } from "@/lib/errors/finalize-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { signSqsMessageAttributes } from "@/lib/sqs-message-auth";
import { executeWorkflow } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

let _sqsClient: SQSClient | null = null;
function getSqsClient(): SQSClient {
  if (!_sqsClient) {
    _sqsClient = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      ...(process.env.AWS_ENDPOINT_URL
        ? {
            endpoint: process.env.AWS_ENDPOINT_URL,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
            },
          }
        : {}),
    });
  }
  return _sqsClient;
}

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
  organizationPlan?: string,
  triggerType: "manual" | "webhook" = "manual"
): Promise<void> {
  try {
    console.log(`${context.logPrefix} Starting execution:`, executionId);

    // When WORKFLOW_DISPATCH_VIA_EXECUTOR is set, route execution through the
    // standalone keeperhub-executor (in-process mode) via SQS instead of the
    // DevKit's embedded graphile worker. This bypasses /.well-known/workflow/v1/step
    // compilation, which deadlocks on the full 91-step bundle in dev.
    // The executor transitions the row from 'pending' -> 'running' -> terminal
    // directly, so we do not pre-lift the status here.
    if (process.env.WORKFLOW_DISPATCH_VIA_EXECUTOR === "1") {
      const body = JSON.stringify({
        executionId,
        workflowId,
        userId: createdBy ?? "",
        organizationId: organizationId ?? undefined,
        triggerType,
        input,
      });
      await getSqsClient().send(
        new SendMessageCommand({
          QueueUrl: process.env.SQS_QUEUE_URL,
          MessageBody: body,
          MessageAttributes: signSqsMessageAttributes("app", body),
        })
      );
      console.log(
        `${context.logPrefix} Dispatched to executor via SQS:`,
        executionId
      );
      return;
    }

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
        status: statusForErrorType(
          isDefaultClassification(classification)
            ? null
            : classification.errorType
        ),
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
