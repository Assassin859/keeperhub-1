import "server-only";

import { eq } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-key-auth";
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
  | { mode: "accessDenied" }
  | { mode: "invalidAuth"; error: string }
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

function isRealAuthenticatedCaller(
  authContext: DualAuthContext
): authContext is AuthenticatedContext {
  if ("error" in authContext) {
    return false;
  }
  if (authContext.isAnonymous) {
    return false;
  }
  return Boolean(authContext.userId || authContext.organizationId);
}

function isPubliclyShareableWorkflow(
  workflow: AuthorizedExecution["workflow"]
): boolean {
  if (workflow.deletedAt) {
    return false;
  }
  if (!workflow.shareExecutionStatus) {
    return false;
  }
  const visibility = workflow.visibility;
  return visibility === "public" || visibility === "unlisted";
}

async function resolveInvalidApiKeyAuth(
  request: Request
): Promise<{ mode: "invalidAuth"; error: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer kh_")) {
    return null;
  }
  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth.authenticated) {
    return null;
  }
  return {
    mode: "invalidAuth",
    error: apiKeyAuth.error ?? "Unauthorized",
  };
}

/**
 * Strip verbose internals from status payloads served to unauthenticated
 * viewers of opted-in public/unlisted workflow executions.
 */
export function redactExecutionStatusForPublicView(
  payload: ExecutionStatusPayload
): ExecutionStatusPayload {
  const redactedNodeStatuses = payload.nodeStatuses.map((node) => ({
    status: node.status,
    nodeId: "",
  }));

  return {
    ...payload,
    nodeStatuses: redactedNodeStatuses,
    progress: {
      ...payload.progress,
      currentNodeId: null,
      currentNodeName: null,
    },
    errorContext: payload.errorContext
      ? {
          failedNodeId: null,
          lastSuccessfulNodeId: null,
          lastSuccessfulNodeName: null,
        }
      : null,
    transactionHashes: payload.transactionHashes.map((entry) => ({
      ...entry,
      nodeName: "",
    })),
  };
}

/**
 * Resolve how a caller may view an execution: full org access, public read-only
 * (opted-in public/unlisted workflow), access denied (authenticated but no
 * access), invalid auth (malformed API key), or not found (unknown id or
 * unauthenticated private — anti-enumeration).
 */
export async function resolveExecutionViewAccess(
  request: Request,
  executionId: string
): Promise<ExecutionViewAccess> {
  const invalidApiKey = await resolveInvalidApiKeyAuth(request);
  if (invalidApiKey) {
    return invalidApiKey;
  }

  const execution = await loadExecutionWithWorkflow(executionId);
  if (!execution) {
    return { mode: "notFound" };
  }

  const authContext = await getDualAuthContext(request, { required: false });
  if ("error" in authContext) {
    return { mode: "notFound" };
  }

  if (isRealAuthenticatedCaller(authContext)) {
    const access = await getWorkflowAccess(execution.workflow, {
      userId: authContext.userId,
      organizationId: authContext.organizationId,
      authMethod: authContext.authMethod,
    });
    if (access.hasFullAccess && !access.isDeleted) {
      return { mode: "full", execution };
    }
  }

  if (isPubliclyShareableWorkflow(execution.workflow)) {
    return { mode: "publicReadOnly", execution };
  }

  if (isRealAuthenticatedCaller(authContext)) {
    return { mode: "accessDenied" };
  }

  return { mode: "notFound" };
}

/**
 * Authenticate the request, load the execution, and verify the caller may see
 * it. Shared by the logs and wait endpoints so they apply identical auth and
 * soft-delete rules. A soft-deleted workflow hides its executions, so those
 * collapse to 404 rather than leaking existence.
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
