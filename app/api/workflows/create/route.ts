import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { projects, tags, workflows } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";
function createDefaultNodes() {
  const triggerId = nanoid();
  const actionId = nanoid();
  const edgeId = nanoid();

  const triggerNode = {
    id: triggerId,
    type: "trigger" as const,
    position: { x: 0, y: 0 },
    data: {
      label: "",
      description: "",
      type: "trigger" as const,
      config: { triggerType: "Manual" },
      status: "idle" as const,
    },
  };

  const actionNode = {
    id: actionId,
    type: "action" as const,
    position: { x: 272, y: 0 },
    selected: true,
    data: {
      label: "",
      description: "",
      type: "action" as const,
      config: {},
      status: "idle" as const,
    },
  };

  const edge = {
    id: edgeId,
    source: triggerId,
    target: actionId,
    type: "animated",
  };

  return { nodes: [triggerNode, actionNode], edges: [edge] };
}

// Helper to generate workflow name
async function generateWorkflowName(
  name: string,
  userId: string,
  organizationId: string | null
): Promise<string> {
  if (name !== "Untitled Workflow") {
    return name;
  }

  const isAnonymous = !organizationId;
  const userWorkflows = isAnonymous
    ? await db.query.workflows.findMany({
        where: and(
          eq(workflows.userId, userId),
          eq(workflows.isAnonymous, true)
        ),
      })
    : await db.query.workflows.findMany({
        where: and(
          eq(workflows.organizationId, organizationId ?? ""),
          eq(workflows.isAnonymous, false)
        ),
      });

  const count = userWorkflows.length + 1;
  return `Untitled ${count}`;
}

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

    const body = await request.json();

    if (!(body.name && body.nodes && body.edges)) {
      return NextResponse.json(
        { error: "Name, nodes, and edges are required" },
        { status: 400 }
      );
    }

    // Validate that all integrationIds in nodes belong to the current user
    const validation = await validateWorkflowIntegrations(
      body.nodes,
      userId,
      organizationId
    );
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Invalid integration references in workflow" },
        { status: 403 }
      );
    }

    // Ensure there are always default nodes (trigger + action) if nodes array is empty
    let nodes = body.nodes;
    let edges = body.edges;
    if (nodes.length === 0) {
      const defaults = createDefaultNodes();
      nodes = defaults.nodes;
      edges = defaults.edges;
    }

    const isAnonymous = !organizationId;
    const workflowName = await generateWorkflowName(
      body.name,
      userId,
      organizationId
    );

    // Validate projectId/tagId ownership when provided
    if (body.projectId !== undefined || body.tagId !== undefined) {
      if (isAnonymous) {
        return NextResponse.json(
          { error: "Cannot assign project or tag without an organization" },
          { status: 400 }
        );
      }

      if (body.projectId) {
        const projRows = await db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, body.projectId),
              eq(projects.organizationId, organizationId ?? "")
            )
          );
        if (projRows.length === 0) {
          return NextResponse.json(
            { error: "Project not found in this organization" },
            { status: 404 }
          );
        }
      }

      if (body.tagId) {
        const tagRows = await db
          .select({ id: tags.id })
          .from(tags)
          .where(
            and(
              eq(tags.id, body.tagId),
              eq(tags.organizationId, organizationId ?? "")
            )
          );
        if (tagRows.length === 0) {
          return NextResponse.json(
            { error: "Tag not found in this organization" },
            { status: 404 }
          );
        }
      }
    }

    // Generate workflow ID first
    const workflowId = generateId();

    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: workflowName,
        description: body.description,
        nodes,
        edges,
        userId,
        organizationId,
        isAnonymous,
        projectId: body.projectId || null,
        tagId: body.tagId || null,
      })
      .returning();

    return NextResponse.json({
      ...newWorkflow,
      createdAt: newWorkflow.createdAt.toISOString(),
      updatedAt: newWorkflow.updatedAt.toISOString(),
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to create workflow", error, {
      endpoint: "/api/workflows/create",
      operation: "create",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create workflow",
      },
      { status: 500 }
    );
  }
}
