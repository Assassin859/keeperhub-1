import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { validateWorkflowIntegrations } from "../lib/db/integrations";
import { organization, workflows } from "../lib/db/schema";
import { executeWorkflow } from "../lib/workflow-executor.workflow";
import { calculateTotalSteps } from "../lib/workflow-progress";
import type { WorkflowEdge, WorkflowNode } from "../lib/workflow-store";
import type { DbSchema } from "./lib/db-helpers";
import {
  initializeExecutionProgress,
  updateExecutionStatus,
  updateScheduleStatus,
} from "./lib/db-helpers";

/**
 * Execute a workflow in-process (no K8s Job).
 * Refactored from keeperhub-executor/workflow-runner.ts main() to be callable
 * from the executor without managing its own process lifecycle.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrates multiple phases of workflow execution
export async function executeInProcess(params: {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  scheduleId?: string;
  db: PostgresJsDatabase<DbSchema>;
}): Promise<void> {
  const { workflowId, executionId, input, scheduleId, db } = params;
  const startTime = Date.now();

  console.log("[Executor:InProcess] Starting workflow execution");
  console.log(`[Executor:InProcess] Workflow ID: ${workflowId}`);
  console.log(`[Executor:InProcess] Execution ID: ${executionId}`);

  try {
    await updateExecutionStatus(db, executionId, "running");

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (workflow.enabled === false) {
      console.log(
        `[Executor:InProcess] Workflow disabled, skipping: ${workflowId}`
      );
      await updateExecutionStatus(db, executionId, "cancelled");
      return;
    }

    let organizationName: string | undefined;
    if (workflow.organizationId) {
      const [org] = await db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, workflow.organizationId))
        .limit(1);
      organizationName = org?.name;
    }

    const nodes = workflow.nodes as WorkflowNode[];
    const edges = workflow.edges as WorkflowEdge[];
    const validation = await validateWorkflowIntegrations(
      nodes,
      workflow.userId,
      workflow.organizationId
    );

    if (!validation.valid) {
      throw new Error(
        `Workflow contains invalid integration references: ${validation.invalidIds?.join(", ")}`
      );
    }

    const totalSteps = calculateTotalSteps(nodes, edges);
    await initializeExecutionProgress(db, executionId, totalSteps);

    console.log("[Executor:InProcess] Executing workflow...");
    const result = await executeWorkflow({
      nodes,
      edges,
      triggerInput: input,
      executionId,
      workflowId,
      organizationId: workflow.organizationId ?? undefined,
      organizationName,
    });

    const duration = Date.now() - startTime;
    console.log(`[Executor:InProcess] Completed in ${duration}ms`);

    if (result.success) {
      await updateExecutionStatus(db, executionId, "success", {
        output: result.outputs,
      });

      if (scheduleId) {
        await updateScheduleStatus(db, scheduleId, "success");
      }

      console.log("[Executor:InProcess] Execution completed successfully");
    } else {
      const errorMessage =
        result.error ||
        Object.values(result.results || {}).find((r) => !r.success)?.error ||
        "Unknown error";

      await updateExecutionStatus(db, executionId, "error", {
        error: errorMessage,
        output: result.outputs,
      });

      if (scheduleId) {
        await updateScheduleStatus(db, scheduleId, "error", errorMessage);
      }

      console.error(
        "[Executor:InProcess] Workflow execution failed:",
        errorMessage
      );
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    console.error(
      `[Executor:InProcess] Fatal error after ${duration}ms:`,
      errorMessage
    );

    try {
      await updateExecutionStatus(db, executionId, "error", {
        error: errorMessage,
      });

      if (scheduleId) {
        await updateScheduleStatus(db, scheduleId, "error", errorMessage);
      }
    } catch (updateError) {
      console.error(
        "[Executor:InProcess] Failed to update execution status:",
        updateError
      );
    }
  }
}
