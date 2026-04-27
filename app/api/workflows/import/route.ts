import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { generateId } from "@/lib/utils/id";
import {
  stripIntegrationsFromImportNodes,
  WORKFLOW_EXPORT_VERSION,
  workflowExportV1Schema,
} from "@/lib/workflow/export-schema";
import { sanitizeWorkflowData } from "@/lib/workflow/sanitize-nodes";

const versionedBodySchema = z
  .object({ version: z.unknown() })
  .passthrough();

export async function POST(request: Request) {
  try {
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId } = authContext;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody: unknown = await request.json();

    const versionCheck = versionedBodySchema.safeParse(rawBody);
    if (!versionCheck.success) {
      return NextResponse.json(
        { error: "Invalid workflow export: not a JSON object" },
        { status: 400 }
      );
    }
    if (versionCheck.data.version !== WORKFLOW_EXPORT_VERSION) {
      return NextResponse.json(
        {
          error: `Unsupported workflow export version: ${String(
            versionCheck.data.version
          )}. Expected version ${WORKFLOW_EXPORT_VERSION}.`,
        },
        { status: 400 }
      );
    }

    const parsed = workflowExportV1Schema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid workflow export format",
          details: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    const exportPayload = parsed.data;
    const isAnonymous = !organizationId;

    const importNodes = stripIntegrationsFromImportNodes(exportPayload.nodes);
    const sanitized = sanitizeWorkflowData(
      importNodes,
      exportPayload.edges as Record<string, unknown>[]
    );

    const validation = await validateWorkflowIntegrations(
      sanitized.nodes,
      userId,
      organizationId
    );
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Invalid integration references in workflow" },
        { status: 403 }
      );
    }

    const workflowId = generateId();
    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: exportPayload.workflow.name,
        description: exportPayload.workflow.description,
        nodes: sanitized.nodes,
        edges: sanitized.edges,
        userId,
        organizationId,
        isAnonymous,
      })
      .returning();

    return NextResponse.json({
      ...newWorkflow,
      createdAt: newWorkflow.createdAt.toISOString(),
      updatedAt: newWorkflow.updatedAt.toISOString(),
      integrationBindings: exportPayload.integrationBindings,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to import workflow", error, {
      endpoint: "/api/workflows/import",
      operation: "import",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to import workflow",
      },
      { status: 500 }
    );
  }
}
