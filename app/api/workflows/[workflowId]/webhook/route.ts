import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  createTimer,
  getMetricsCollector,
} from "@/lib/metrics";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import {
  EXECUTION_LIMIT_ERROR,
  enforceExecutionLimit,
} from "@/lib/billing/execution-guard";
import { checkConcurrencyLimit } from "@/app/api/execute/_lib/concurrency-limit";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { recordWebhookMetrics } from "@/lib/metrics/instrumentation/api";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { extractActionTypeNodes } from "@/lib/features";
import {
  enforceWorkflowFeatures,
  FEATURE_UPGRADE_REQUIRED_ERROR,
} from "@/lib/features/route-guard";
import {
  apiKeys,
  organization,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { getOrgPlanLabel, getOrgSlug } from "@/lib/db/org-helpers";
import { withBackstopCapture } from "@/lib/security/backstop-capture";
import { buildAttribution } from "@/lib/security/request-attribution";
import {
  getWorkflowAccess,
  isUserMemberOfOrganization,
} from "@/lib/workflow/access";
import { getWorkflowExecutability } from "@/lib/workflow/executable";
import { executeWorkflowInBackground } from "@/lib/workflow/execute-in-background";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";
type ValidateApiKeyResult = {
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
  error?: string;
  statusCode?: number;
  errorBody?: Record<string, unknown>;
};

// Validate API key and return the user ID if valid. The org owns the
// workflow, so the key must belong to a CURRENT MEMBER of the workflow's
// org - not specifically its creator.
async function validateApiKey(
  authHeader: string | null,
  workflowOrganizationId: string
): Promise<ValidateApiKeyResult> {
  if (!authHeader) {
    return {
      valid: false,
      error: "Missing Authorization header",
      statusCode: 401,
    };
  }

  // Support "Bearer <key>" format
  const key = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!key?.startsWith("wfb_")) {
    // Builders frequently paste their org-scoped kh_* key here because the
    // rest of the API accepts it. Surface the prefix mismatch explicitly so
    // they don't have to discover via Discord that this endpoint expects a
    // user webhook key (KEEP-469).
    if (key?.startsWith("kh_")) {
      return {
        valid: false,
        statusCode: 401,
        error:
          "Wrong API key type. This endpoint requires a user webhook key (wfb_*). The kh_* prefix is an org API key for /api/execute/* and /mcp.",
        errorBody: {
          code: "wrong_key_type",
          expected: "wfb_*",
          received: "kh_*",
          hint: "Generate a webhook key from the user menu > API Keys > Webhook tab, then pass it as `Authorization: Bearer wfb_...`.",
        },
      };
    }
    return {
      valid: false,
      statusCode: 401,
      error:
        "Invalid API key format. Expected a user webhook key starting with wfb_.",
      errorBody: {
        code: "invalid_key_format",
        expected: "wfb_*",
      },
    };
  }

  // Hash the key to compare with stored hash
  const keyHash = createHash("sha256").update(key).digest("hex");

  // Find the API key in the database
  const apiKey = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });

  if (!apiKey) {
    return { valid: false, error: "Invalid API key", statusCode: 401 };
  }

  // Verify the key's holder is a current member of the workflow's org.
  // (A deactivated member cannot reach here: the deactivation cascade
  // deletes their api_keys rows.)
  const isMember = await isUserMemberOfOrganization(
    apiKey.userId,
    workflowOrganizationId
  );
  if (!isMember) {
    return {
      valid: false,
      error: "You do not have permission to run this workflow",
      statusCode: 403,
    };
  }

  // Update last used timestamp (don't await, fire and forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKey.id))
    .catch(() => {
      // Fire and forget - ignore errors
    });

  return { valid: true, userId: apiKey.userId, apiKeyId: apiKey.id };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * Build a `{ error: message }` JSON response and emit the matching webhook
 * metric in one call. Covers the simple-error gates (404, 410, 401, 403, 400,
 * 500). The two 429 variants have custom response bodies and stay inline.
 */
async function failResponse(
  workflowId: string,
  timer: () => number,
  statusCode: number,
  message: string,
  extraBody?: Record<string, unknown>
): Promise<NextResponse> {
  await recordWebhookMetrics({
    workflowId,
    durationMs: timer(),
    statusCode,
    error: message,
  });
  return NextResponse.json(
    { error: message, ...extraBody },
    { status: statusCode, headers: corsHeaders }
  );
}

export function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const timer = createTimer();

  try {
    const { workflowId } = await context.params;

    // Get workflow
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failResponse(workflowId, timer, 404, "Workflow not found");
    }

    // Gate on workflow lifecycle (enabled, not soft-deleted, owner active)
    // using the shared executability predicate, before API-key
    // validation so a non-executable workflow never triggers an auth round-trip.
    // A disabled workflow stays a 410; a deleted or deactivated-owner workflow
    // is reported as gone (404).
    const [gate] = await db
      .select({ orgDeactivatedAt: organization.deactivatedAt })
      .from(workflows)
      .leftJoin(organization, eq(organization.id, workflows.organizationId))
      .where(eq(workflows.id, workflow.id))
      .limit(1);
    const executability = getWorkflowExecutability({
      enabled: workflow.enabled,
      deletedAt: workflow.deletedAt,
      deactivatedAt: workflow.deactivatedAt,
      orgDeactivatedAt: gate?.orgDeactivatedAt ?? null,
    });
    if (!executability.executable) {
      if (executability.reason === "disabled") {
        return failResponse(workflowId, timer, 410, "Workflow is disabled");
      }
      return failResponse(workflowId, timer, 404, "Workflow not found");
    }

    // Validate API key - must belong to the workflow owner
    const authHeader = request.headers.get("Authorization");
    const apiKeyValidation = await validateApiKey(
      authHeader,
      workflow.organizationId
    );

    if (!apiKeyValidation.valid) {
      return failResponse(
        workflowId,
        timer,
        apiKeyValidation.statusCode ?? 401,
        apiKeyValidation.error ?? "Invalid API key",
        apiKeyValidation.errorBody
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId: apiKeyValidation.userId ?? null,
      organizationId: workflow.organizationId,
      authMethod: "webhook",
    });

    if (!access.hasFullAccess) {
      return failResponse(workflowId, timer, 404, "Workflow not found");
    }

    // Verify this is a webhook-triggered workflow
    const triggerNode = (workflow.nodes as WorkflowNode[]).find(
      (node) => node.data.type === "trigger"
    );

    if (!triggerNode || triggerNode.data.config?.triggerType !== "Webhook") {
      return failResponse(
        workflowId,
        timer,
        400,
        "This workflow is not configured for webhook triggers"
      );
    }

    // Validate integration references as the ORG principal (the org owns the
    // workflow), matching the runtime credential fetch.
    const validation = await validateWorkflowIntegrations(
      workflow.nodes as WorkflowNode[],
      null,
      workflow.organizationId
    );
    if (!validation.valid) {
      logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Webhook] Invalid integration references", new Error(String(validation.invalidIds)), { endpoint: "/api/workflows/[workflowId]/webhook", operation: "validateIntegrations" });
      return failResponse(
        workflowId,
        timer,
        403,
        "Workflow contains invalid integration references"
      );
    }

    const featureGuard = await enforceWorkflowFeatures(
      extractActionTypeNodes(workflow.nodes as unknown[]),
      workflow.organizationId
    );
    if (featureGuard.blocked) {
      await recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 402,
        error: FEATURE_UPGRADE_REQUIRED_ERROR,
        organizationId: workflow.organizationId,
      });
      const body = await featureGuard.response.json();
      return NextResponse.json(body, {
        status: 402,
        headers: corsHeaders,
      });
    }

    const executionGuard = await enforceExecutionLimit(workflow.organizationId);
    if (executionGuard.blocked) {
      await recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 429,
        error: EXECUTION_LIMIT_ERROR,
        organizationId: workflow.organizationId,
      });
      const body = await executionGuard.response.json();
      return NextResponse.json(body, {
        status: 429,
        headers: corsHeaders,
      });
    }

    const concurrencyCheck = await checkConcurrencyLimit();
    if (!concurrencyCheck.allowed) {
      await recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 429,
        error: "Too many concurrent workflow executions",
        organizationId: workflow.organizationId,
      });
      return NextResponse.json(
        {
          error: "Too many concurrent workflow executions",
          running: concurrencyCheck.running,
          limit: concurrencyCheck.limit,
        },
        { status: 429, headers: { ...corsHeaders, "Retry-After": "30" } }
      );
    }

    // Parse request body
    const body = await request.json().catch(() => ({}));

    const attribution = buildAttribution({
      request,
      source: "webhook",
      userApiKeyId: apiKeyValidation.apiKeyId ?? null,
    });

    // Create execution record
    const [execution] = await withBackstopCapture(
      { workflowId, userId: workflow.userId, source: "webhook" },
      () =>
        db
          .insert(workflowExecutions)
          .values({
            workflowId,
            userId: workflow.userId,
            status: "pending",
            input: body,
            ...attribution,
          })
          .returning()
    );

    console.log("[Webhook] Created execution:", execution.id);

    // Record per-(trigger_type, chain) start of a workflow execution. See KEEP-556.
    const chainLabel = workflow.chain ?? "_unknown";
    const metrics = getMetricsCollector();
    metrics.incrementCounter(MetricNames.WORKFLOW_EXECUTIONS_STARTED_TOTAL, {
      [LabelKeys.TRIGGER_TYPE]: "webhook",
      [LabelKeys.CHAIN]: chainLabel,
    });

    // Resolve org slug + plan for log labels (cached per request)
    const [organizationSlug, organizationPlan] = await Promise.all([
      getOrgSlug(workflow.organizationId),
      getOrgPlanLabel(workflow.organizationId),
    ]);

    // Execute the workflow in the background (don't await)
    executeWorkflowInBackground(
      execution.id,
      workflowId,
      workflow.nodes as WorkflowNode[],
      workflow.edges as WorkflowEdge[],
      body,
      {
        logPrefix: "[Webhook]",
        endpoint: "/api/workflows/[workflowId]/webhook",
      },
      workflow.organizationId,
      workflow.userId,
      organizationSlug,
      organizationPlan
    );

    await recordWebhookMetrics({
      workflowId,
      executionId: execution.id,
      durationMs: timer(),
      statusCode: 200,
    });

    // Return immediately with the execution ID
    return NextResponse.json(
      {
        executionId: execution.id,
        status: "running",
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Webhook] Failed to start workflow execution", error, { endpoint: "/api/workflows/[workflowId]/webhook", operation: "post" });

    const { workflowId } = await context.params;
    const message =
      error instanceof Error ? error.message : "Failed to execute workflow";
    return failResponse(workflowId, timer, 500, message);
  }
}
