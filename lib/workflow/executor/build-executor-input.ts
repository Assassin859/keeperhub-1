import type { WorkflowExecutionInput } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

/** Minimal workflow shape needed to build executor input. */
export type ExecutorInputWorkflow = {
  id: string;
  userId: string;
  organizationId: string | null;
  nodes: unknown;
  edges: unknown;
};

/**
 * Build the executor input from a workflow row, always deriving the
 * owner-context principal (`ownerId` / `organizationId`) from the workflow.
 *
 * Centralised so every dispatch entry point (scheduled K8s job, in-process,
 * MCP) threads the same owner context. The database-query step authorizes
 * credential use against this principal; a dropped `ownerId` leaves the
 * principal with a null userId, so org-visibility integrations fail closed
 * and surface the misleading "DATABASE_URL is not configured" error.
 */
export function buildExecutorInput(
  workflow: ExecutorInputWorkflow,
  params: {
    triggerInput?: Record<string, unknown>;
    executionId?: string;
    organizationName?: string;
    organizationSlug?: string;
    organizationPlan?: string;
  }
): WorkflowExecutionInput {
  return {
    nodes: workflow.nodes as WorkflowNode[],
    edges: workflow.edges as WorkflowEdge[],
    triggerInput: params.triggerInput,
    executionId: params.executionId,
    workflowId: workflow.id,
    organizationId: workflow.organizationId ?? undefined,
    ownerId: workflow.userId,
    organizationName: params.organizationName,
    organizationSlug: params.organizationSlug,
    organizationPlan: params.organizationPlan,
  };
}
