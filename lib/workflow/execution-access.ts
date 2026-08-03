import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { TransactionHashEntry } from "@/lib/db/schema";
import { workflowExecutions } from "@/lib/db/schema";
import {
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { getWorkflowAccess } from "@/lib/workflow/access";

type AuthenticatedContext = Exclude<DualAuthContext, { error: string }>;

function loadExecutionWithWorkflow(executionId: string) {
  return db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
    with: { workflow: true },
  });
}

export type AuthorizedExecution = NonNullable<
  Awaited<ReturnType<typeof loadExecutionWithWorkflow>>
>;

export type ExecutionAccessResult =
  | { ok: true; execution: AuthorizedExecution; auth: AuthenticatedContext }
  | { ok: false; status: number; error: string };

export type ExecutionViewAccess =
  | { mode: "full"; execution: AuthorizedExecution }
  | { mode: "publicReadOnly"; execution: AuthorizedExecution }
  | { mode: "signInRequired" }
  | { mode: "notFound" };

type NodeStatus = {
  nodeId: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
};

export type ExecutionStatusPayload = {
  status: string;
  nodeStatuses: NodeStatus[];
  progress: {
    totalSteps: number;
    completedSteps: number;
    runningSteps: number;
    currentNodeId: string | null;
    currentNodeName: string | null;
    percentage: number;
  };
  errorContext: {
    failedNodeId: string | null;
    lastSuccessfulNodeId: string | null;
    lastSuccessfulNodeName: string | null;
    executionTrace?: string[] | null;
    error?: string | null;
  } | null;
  transactionHashes: TransactionHashEntry[];
};

/**
 * Strip verbose internals from status payloads served to unauthenticated
 * viewers of public/unlisted workflows.
 */
export function redactExecutionStatusForPublicView(
  payload: ExecutionStatusPayload
): ExecutionStatusPayload {
  if (!payload.errorContext) {
    return payload;
  }

  return {
    ...payload,
    errorContext: {
      failedNodeId: payload.errorContext.failedNodeId,
      lastSuccessfulNodeId: payload.errorContext.lastSuccessfulNodeId,
      lastSuccessfulNodeName: payload.errorContext.lastSuccessfulNodeName,
    },
  };
}

/**
 * Resolve how a caller may view an execution: full org access, public read-only
 * (public/unlisted workflow), sign-in required (private), or not found.
 */
export async function resolveExecutionViewAccess(
  request: Request,
  executionId: string
): Promise<ExecutionViewAccess> {
  const execution = await loadExecutionWithWorkflow(executionId);
  if (!execution) {
    return { mode: "notFound" };
  }

  const authContext = await getDualAuthContext(request, { required: false });
  if (!("error" in authContext)) {
    const { userId, organizationId } = authContext;
    if (userId || organizationId) {
      const access = await getWorkflowAccess(execution.workflow, {
        userId,
        organizationId,
        authMethod: authContext.authMethod,
      });
      if (access.hasFullAccess && !access.isDeleted) {
        return { mode: "full", execution };
      }
    }
  }

  if (execution.workflow.deletedAt) {
    return { mode: "notFound" };
  }

  const visibility = execution.workflow.visibility;
  if (visibility === "public" || visibility === "unlisted") {
    return { mode: "publicReadOnly", execution };
  }

  return { mode: "signInRequired" };
}

/**
 * Authenticate the request, load the execution, and verify the caller may see
 * it. Shared by the status, logs, and wait endpoints so they apply identical
 * auth and soft-delete rules. A soft-deleted workflow hides its executions, so
 * those collapse to 404 rather than leaking existence.
 */
export async function resolveAuthorizedExecution(
  request: Request,
  executionId: string
): Promise<ExecutionAccessResult> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return { ok: false, status: authContext.status, error: authContext.error };
  }

  const { userId, organizationId } = authContext;
  if (!(userId || organizationId)) {
    return {
      ok: false,
      status: 403,
      error:
        "API key has no associated user or organization. Please recreate the API key.",
    };
  }

  const execution = await loadExecutionWithWorkflow(executionId);
  if (!execution) {
    return { ok: false, status: 404, error: "Execution not found" };
  }

  const access = await getWorkflowAccess(execution.workflow, {
    userId,
    organizationId,
    authMethod: authContext.authMethod,
  });
  if (!access.hasFullAccess || access.isDeleted) {
    return { ok: false, status: 404, error: "Execution not found" };
  }

  return { ok: true, execution, auth: authContext };
}
