/**
 * Workflow Runner Script
 *
 * Executes a single workflow in an isolated K8s Job container.
 * Receives workflow context via environment variables, executes the workflow,
 * updates the database, and exits.
 *
 * Usage (via bootstrap script that patches 'server-only'):
 *   tsx keeperhub-executor/workflow-runner-bootstrap.ts
 *
 * Usage (in Docker container where 'server-only' is already shimmed):
 *   tsx keeperhub-executor/workflow-runner.ts
 *
 * Environment variables (required):
 *   WORKFLOW_ID - ID of the workflow to execute
 *   EXECUTION_ID - ID of the execution record (pre-created by executor)
 *   DATABASE_URL - PostgreSQL connection string
 *   INTEGRATION_ENCRYPTION_KEY - Key for decrypting integration credentials
 *
 * Environment variables (optional):
 *   WORKFLOW_INPUT - JSON string of trigger input (default: {})
 *   SCHEDULE_ID - ID of the schedule (for scheduled executions)
 *   + system credentials from runner-env.ts (ETHERSCAN_API_KEY, etc.)
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { validateWorkflowIntegrations } from "../lib/db/integrations";
import {
  organization,
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "../lib/db/schema";
import { executeWorkflow } from "../lib/workflow-executor.workflow";
import { calculateTotalSteps } from "../lib/workflow-progress";
import { SHUTDOWN_TIMEOUT_MS } from "../lib/workflow-runner/constants";
import type { WorkflowEdge, WorkflowNode } from "../lib/workflow-store";
import {
  initializeExecutionProgress,
  updateExecutionStatus,
  updateScheduleStatus,
} from "./lib/db-helpers";

// Validate required environment variables
function validateEnv(): {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  scheduleId?: string;
} {
  const workflowId = process.env.WORKFLOW_ID;
  const executionId = process.env.EXECUTION_ID;

  if (!workflowId) {
    console.error("[Runner] WORKFLOW_ID environment variable is required");
    process.exit(1);
  }

  if (!executionId) {
    console.error("[Runner] EXECUTION_ID environment variable is required");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("[Runner] DATABASE_URL environment variable is required");
    process.exit(1);
  }

  let input: Record<string, unknown> = {};
  if (process.env.WORKFLOW_INPUT) {
    try {
      input = JSON.parse(process.env.WORKFLOW_INPUT);
    } catch (error) {
      console.error("[Runner] Failed to parse WORKFLOW_INPUT:", error);
      process.exit(1);
    }
  }

  return {
    workflowId,
    executionId,
    input,
    scheduleId: process.env.SCHEDULE_ID,
  };
}

// Database connection with timeout configuration
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}
const queryClient = postgres(connectionString, {
  connect_timeout: 10,
  idle_timeout: 30,
  max_lifetime: 60 * 5,
  connection: { statement_timeout: 30_000 },
});
const db = drizzle(queryClient, {
  schema: { workflows, workflowExecutions, workflowSchedules },
});

// Graceful shutdown state tracking
let isShuttingDown = false;
let currentExecutionId: string | null = null;
let currentScheduleId: string | null = null;

async function handleGracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Runner] Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  console.log(`[Runner] Received ${signal}, initiating graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    console.error("[Runner] Graceful shutdown timeout, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    if (currentExecutionId) {
      console.log(
        `[Runner] Updating execution ${currentExecutionId} status to error`
      );
      await updateExecutionStatus(db, currentExecutionId, "error", {
        error: `Workflow terminated by ${signal} signal`,
      });

      if (currentScheduleId) {
        await updateScheduleStatus(
          db,
          currentScheduleId,
          "error",
          `Workflow terminated by ${signal} signal`
        );
      }
    }

    await queryClient.end();
    console.log("[Runner] Database connection closed");
  } catch (error) {
    console.error("[Runner] Error during graceful shutdown:", error);
  } finally {
    clearTimeout(shutdownTimeout);
    console.log("[Runner] Graceful shutdown complete");
    process.exit(1);
  }
}

process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Main runner orchestrates multiple phases of workflow execution
async function main(): Promise<void> {
  const startTime = Date.now();
  const { workflowId, executionId, input, scheduleId } = validateEnv();

  currentExecutionId = executionId;
  currentScheduleId = scheduleId ?? null;

  console.log("[Runner] Starting workflow execution");
  console.log(`[Runner] Workflow ID: ${workflowId}`);
  console.log(`[Runner] Execution ID: ${executionId}`);
  console.log(`[Runner] Schedule ID: ${scheduleId || "none"}`);

  try {
    if (isShuttingDown) {
      console.log("[Runner] Shutdown in progress, aborting execution");
      return;
    }

    await updateExecutionStatus(db, executionId, "running");

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (workflow.enabled === false) {
      console.log(
        `[Runner] Workflow disabled, skipping execution: ${workflowId}`
      );
      await updateExecutionStatus(db, executionId, "cancelled");
      return;
    }

    console.log(`[Runner] Loaded workflow: ${workflow.name || workflowId}`);

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
    console.log(`[Runner] Total steps: ${totalSteps}`);
    await initializeExecutionProgress(db, executionId, totalSteps);

    if (isShuttingDown) {
      console.log("[Runner] Shutdown requested, aborting before execution");
      return;
    }

    console.log("[Runner] Executing workflow...");
    const result = await executeWorkflow({
      nodes,
      edges: workflow.edges as WorkflowEdge[],
      triggerInput: input,
      executionId,
      workflowId,
      organizationId: workflow.organizationId ?? undefined,
      organizationName,
    });

    const duration = Date.now() - startTime;
    console.log(`[Runner] Workflow completed in ${duration}ms`);
    console.log(`[Runner] Success: ${result.success}`);

    if (result.success) {
      await updateExecutionStatus(db, executionId, "success", {
        output: result.outputs,
      });

      if (scheduleId) {
        await updateScheduleStatus(db, scheduleId, "success");
      }

      currentExecutionId = null;
      console.log("[Runner] Execution completed successfully");
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

      currentExecutionId = null;
      console.error("[Runner] Workflow execution failed:", errorMessage);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    console.error(`[Runner] Fatal error after ${duration}ms:`, errorMessage);

    let dbUpdateSucceeded = false;
    try {
      await updateExecutionStatus(db, executionId, "error", {
        error: errorMessage,
      });

      if (scheduleId) {
        await updateScheduleStatus(db, scheduleId, "error", errorMessage);
      }
      dbUpdateSucceeded = true;
    } catch (updateError) {
      console.error("[Runner] Failed to update execution status:", updateError);
      process.exitCode = 1;
    }

    currentExecutionId = null;

    if (dbUpdateSucceeded) {
      console.log("[Runner] Error recorded to database, exiting normally");
    }
  } finally {
    if (!isShuttingDown) {
      await queryClient.end();
      console.log("[Runner] Database connection closed");
    }
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error("[Runner] Unhandled error:", error);
    process.exit(1);
  });
