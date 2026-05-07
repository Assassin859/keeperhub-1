import { eq, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { projects, publicTags, tags, workflowExecutions, workflowPublicTags, workflows } from "@/lib/db/schema";
import { findFirstWriteActionNode } from "@/lib/mcp/calldata";
import {
  findBareAtLiterals,
  isInputSchemaPresent,
} from "@/lib/mcp/listing-validators";
import { syncWorkflowSchedule } from "@/lib/schedule-service";
import { sanitizeDescription } from "@/lib/sanitize-description";
import { sanitizeWorkflowData } from "@/lib/workflow/editor/sanitize-nodes";
import { isReservedSlug } from "@/lib/workflow/reserved-slugs";
async function fetchWorkflowPublicTags(
  workflowId: string
): Promise<Array<{ id: string; name: string; slug: string }>> {
  const rows = await db
    .select({
      id: publicTags.id,
      name: publicTags.name,
      slug: publicTags.slug,
    })
    .from(workflowPublicTags)
    .innerJoin(publicTags, eq(workflowPublicTags.publicTagId, publicTags.id))
    .where(eq(workflowPublicTags.workflowId, workflowId));
  return rows;
}

// Helper to strip sensitive data from nodes for public viewing
function sanitizeNodesForPublicView(
  nodes: Record<string, unknown>[]
): Record<string, unknown>[] {
  return nodes.map((node) => {
    const sanitizedNode = { ...node };
    if (
      sanitizedNode.data &&
      typeof sanitizedNode.data === "object" &&
      sanitizedNode.data !== null
    ) {
      const data = { ...(sanitizedNode.data as Record<string, unknown>) };
      // Remove integrationId from config to not expose which integrations are used
      if (
        data.config &&
        typeof data.config === "object" &&
        data.config !== null
      ) {
        const { integrationId: _, ...configWithoutIntegration } =
          data.config as Record<string, unknown>;
        data.config = configWithoutIntegration;
      }
      sanitizedNode.data = data;
    }
    return sanitizedNode;
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request, { required: false });
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { userId, organizationId } = authContext;

    // First, try to find the workflow
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const isOwner = userId === workflow.userId;

    // Check organization membership for private workflows
    const isSameOrg =
      !workflow.isAnonymous &&
      workflow.organizationId &&
      organizationId === workflow.organizationId;

    // Access control:
    // - Public workflows: anyone can view (sanitized)
    // - Private workflows: owner or org member can view
    // - Anonymous workflows: only owner can view
    if (!isOwner && workflow.visibility !== "public" && !isSameOrg) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const hasFullAccess = isOwner || isSameOrg;

    const workflowTags = await fetchWorkflowPublicTags(workflowId);

    // For public workflows viewed by non-owners, sanitize sensitive data
    const responseData = {
      ...workflow,
      nodes: hasFullAccess
        ? workflow.nodes
        : sanitizeNodesForPublicView(
            workflow.nodes as Record<string, unknown>[]
          ),
      publicTags: workflowTags,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
      // Note: `isOwner` controls edit permissions in the frontend.
      // We use `hasFullAccess` here so that all org members can edit,
      // not just the original creator. This is a bit of a misnomer but
      // avoids refactoring the frontend atom naming (isWorkflowOwnerAtom).
      isOwner: hasFullAccess,
    };

    // INFRA-05: Sanitize description for non-owner reads of listed workflows
    if (!hasFullAccess && workflow.isListed && responseData.description) {
      responseData.description = sanitizeDescription(responseData.description);
    }

    return NextResponse.json(responseData);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get workflow",
      },
      { status: 500 }
    );
  }
}

// Helper to build update data from request body
function buildUpdateData(
  body: Record<string, unknown>
): Record<string, unknown> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  const fields = [
    "name",
    "description",
    "nodes",
    "edges",
    "visibility",
    "enabled", // keeperhub custom field //
    "projectId", // keeperhub custom field //
    "tagId", // keeperhub custom field //
    "isListed", // v1.7 listing fields //
    "listedSlug", // v1.7 listing fields //
    "inputSchema", // v1.7 listing fields //
    "outputMapping", // v1.7 listing fields //
    "priceUsdcPerCall", // v1.7 listing fields //
  ];
  for (const field of fields) {
    if (body[field] !== undefined) {
      updateData[field] = body[field];
    }
  }

  // Sanitize nodes/edges: strip React Flow UI state and normalize MCP-generated formats
  if (Array.isArray(updateData.nodes) || Array.isArray(updateData.edges)) {
    const nodes = (updateData.nodes ?? []) as Record<string, unknown>[];
    const edges = (updateData.edges ?? []) as Record<string, unknown>[];
    const sanitized = sanitizeWorkflowData(nodes, edges);
    if (updateData.nodes !== undefined) {
      updateData.nodes = sanitized.nodes;
    }
    if (updateData.edges !== undefined) {
      updateData.edges = sanitized.edges;
    }
  }

  return updateData;
}

// Helper to validate visibility value
function isValidVisibility(visibility: unknown): boolean {
  return (
    visibility === undefined ||
    visibility === "private" ||
    visibility === "public"
  );
}

// Helper to validate workflow access for PATCH/DELETE operations
async function validateWorkflowAccess(
  workflowId: string,
  userId: string | null,
  organizationId: string | null
): Promise<{
  workflow: typeof workflows.$inferSelect | null;
  hasAccess: boolean;
}> {
  const existingWorkflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, workflowId),
  });

  if (!existingWorkflow) {
    return { workflow: null, hasAccess: false };
  }

  const isOwner = userId ? existingWorkflow.userId === userId : false;
  const isSameOrg =
    !existingWorkflow.isAnonymous &&
    existingWorkflow.organizationId &&
    organizationId === existingWorkflow.organizationId;

  return {
    workflow: existingWorkflow,
    hasAccess: isOwner || Boolean(isSameOrg),
  };
}

async function handlePostUpdateSideEffects(
  workflowId: string,
  body: Record<string, unknown>
): Promise<void> {
  if (body.visibility === "private") {
    await db
      .delete(workflowPublicTags)
      .where(eq(workflowPublicTags.workflowId, workflowId));
  }

  // Marketplace leaderboard caches tags + isListed for 60s. Drop the cache
  // whenever a change might have flipped a row in or out of the listed set,
  // or rewritten the tag column on a still-listed row.
  if (
    body.isListed !== undefined ||
    body.visibility !== undefined ||
    body.priceUsdcPerCall !== undefined
  ) {
    revalidateTag("marketplace", "max");
  }

  if (body.nodes !== undefined) {
    const syncResult = await syncWorkflowSchedule(
      workflowId,
      body.nodes as Parameters<typeof syncWorkflowSchedule>[1]
    );
    if (!syncResult.synced) {
      console.warn(
        `[Workflow] Schedule sync failed for ${workflowId}:`,
        syncResult.error
      );
    }
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId } = authContext;
    const { workflow: existingWorkflow, hasAccess } =
      await validateWorkflowAccess(workflowId, userId, organizationId);

    if (!(existingWorkflow && hasAccess)) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const body = await request.json();

    // Validate that all integrationIds in nodes belong to the current user
    if (Array.isArray(body.nodes)) {
      const validation = await validateWorkflowIntegrations(
        body.nodes,
        userId || existingWorkflow.userId,
        organizationId
      );
      if (!validation.valid) {
        return NextResponse.json(
          { error: "Invalid integration references in workflow" },
          { status: 403 }
        );
      }
    }

    // Validate visibility value if provided
    if (!isValidVisibility(body.visibility)) {
      return NextResponse.json(
        { error: "Invalid visibility value. Must be 'private' or 'public'" },
        { status: 400 }
      );
    }

    // Validate projectId/tagId ownership when provided
    if (body.projectId !== undefined || body.tagId !== undefined) {
      const targetOrgId = existingWorkflow.organizationId || organizationId;

      if (!targetOrgId) {
        if (body.projectId || body.tagId) {
          return NextResponse.json(
            { error: "Cannot assign project or tag without an organization" },
            { status: 400 }
          );
        }
      } else {
        if (body.projectId) {
          const projRows = await db
            .select({ orgId: projects.organizationId })
            .from(projects)
            .where(eq(projects.id, body.projectId));
          if (!(projRows[0] && projRows[0].orgId === targetOrgId)) {
            return NextResponse.json(
              { error: "Project not found in this organization" },
              { status: 404 }
            );
          }
        }
        if (body.tagId) {
          const tagRows = await db
            .select({ orgId: tags.organizationId })
            .from(tags)
            .where(eq(tags.id, body.tagId));
          if (!(tagRows[0] && tagRows[0].orgId === targetOrgId)) {
            return NextResponse.json(
              { error: "Tag not found in this organization" },
              { status: 404 }
            );
          }
        }
      }
    }

    // Reserved-slug guard (HUB-11): reject listed slugs that collide with reserved
    // path segments under /hub/tags/[tag]. Applies only to non-null new values.
    if (
      body.listedSlug !== undefined &&
      body.listedSlug !== null &&
      typeof body.listedSlug === "string" &&
      isReservedSlug(body.listedSlug)
    ) {
      return NextResponse.json(
        {
          error: `"${body.listedSlug}" is a reserved word and cannot be used.`,
        },
        { status: 400 }
      );
    }

    // Slug immutability: reject changes to listedSlug when workflow is already listed
    if (
      body.listedSlug !== undefined &&
      existingWorkflow.isListed === true &&
      existingWorkflow.listedSlug !== null &&
      body.listedSlug !== existingWorkflow.listedSlug
    ) {
      return NextResponse.json(
        { error: "This slug cannot be changed after listing. Create a new workflow if you need a different slug." },
        { status: 400 }
      );
    }

    const updateData = buildUpdateData(body);

    // Set listedAt server-side on first listing (never from client, never cleared on unlist)
    if (body.isListed === true && existingWorkflow.listedAt === null) {
      updateData.listedAt = new Date();
    }

    // Re-run the publish-time gates from /listing/route.ts when this PATCH
    // either (a) edits a workflow that's already listed or (b) is the act of
    // listing it. This route is a backdoor around the dedicated listing
    // curator route — without these checks an author could publish a clean
    // workflow via /listing then PATCH `nodes` here to introduce a bare-@
    // literal, leaving a broken listing live in the bazaar.
    //
    // Field-touched-only semantics: stay backwards-compatible with workflows
    // listed before the gates existed by only validating the field the PATCH
    // actually changes. Legacy listings with null inputSchema continue to
    // work until the next edit that touches THAT field. The exception is a
    // fresh isListed=true transition through this route, which validates the
    // full final state (effectively a publish event).
    //
    // Unlist-and-clean-up bypass: a PATCH that explicitly sets isListed=false
    // is leaving the listed surface — the bazaar will never see the
    // post-patch state, so there's no value in blocking the user from fixing
    // a corrupted workflow on the way out. Skip the gates in that case.
    //
    // The 422 messages here intentionally diverge from the listing curator's
    // (app/api/mcp/workflows/[slug]/listing/route.ts:mapListingError) — they
    // include "or unlist the workflow before saving these changes" as
    // context-aware UX guidance. The curator-publish path has no such
    // option, so its messages don't mention unlisting.
    const isTransitioningToUnlisted =
      body.isListed === false && existingWorkflow.isListed === true;
    const isTransitioningToListed =
      body.isListed === true && existingWorkflow.isListed !== true;
    const willBeListed =
      !isTransitioningToUnlisted &&
      (isTransitioningToListed || existingWorkflow.isListed === true);

    if (willBeListed) {
      const checkNodes =
        updateData.nodes !== undefined || isTransitioningToListed;
      const finalNodes =
        updateData.nodes !== undefined
          ? updateData.nodes
          : existingWorkflow.nodes;
      const checkSchema =
        updateData.inputSchema !== undefined || isTransitioningToListed;
      const finalSchema =
        updateData.inputSchema !== undefined
          ? updateData.inputSchema
          : existingWorkflow.inputSchema;

      // Gate ordering matches the publish path (lib/mcp/listing.ts::listWorkflow):
      // write-action -> bare-@ -> input-schema. Same DB state therefore yields
      // the same error code regardless of which gate-bearing route the caller
      // hits, which keeps client-side error handling consistent.
      //
      // workflowType is curator-only — it's not in `buildUpdateData`'s field
      // allowlist (lines 156-170 above), so a body's `workflowType` is silently
      // dropped at the persistence layer. We read it directly from
      // `existingWorkflow.workflowType` (no fallback chain) so the gate truly
      // reflects what will be persisted. Type changes flow through
      // updateWorkflowListing (lib/mcp/listing.ts), which is unconditionally
      // strict.
      // `finalNodes` is `unknown` (updateData.nodes is unknown after the
      // generic Record cast). Both code paths actually hold an array — the
      // body branch went through `sanitizeWorkflowData`, the existing branch
      // is `nodes` declared `$type<any[]>` in lib/db/schema.ts. The cast is
      // honest and matches how lib/mcp/listing.ts:151 calls the same function.
      if (
        checkNodes &&
        existingWorkflow.workflowType === "write" &&
        findFirstWriteActionNode(finalNodes as unknown[]) === undefined
      ) {
        return NextResponse.json(
          {
            error: "MISSING_WRITE_ACTION",
            message:
              "Workflows listed as workflowType='write' must contain at least one write-contract or protocol-write action node. Add the action back, or unlist the workflow before saving these changes.",
          },
          { status: 422 }
        );
      }

      if (checkNodes) {
        const literals = findBareAtLiterals(finalNodes);
        if (literals.length > 0) {
          return NextResponse.json(
            {
              error: "INVALID_TEMPLATE_LITERALS",
              message:
                "Listed workflow contains a bare `@<word>` literal in a node config field outside a `{{...}}` template wrapper. Replace it with a `{{@nodeId:Label.field}}` reference, or unlist the workflow before saving these changes.",
              literals,
            },
            { status: 422 }
          );
        }
      }
      if (checkSchema && !isInputSchemaPresent(finalSchema)) {
        return NextResponse.json(
          {
            error: "INPUT_SCHEMA_REQUIRED",
            message:
              'Listed workflows must declare an `inputSchema`. Set it to a JSON-schema-shaped object (`{"type": "object"}` is fine for workflows that take no inputs), or unlist the workflow before saving these changes.',
          },
          { status: 422 }
        );
      }
    }

    // Bump listingVersion when a listed (or about-to-be-listed) workflow has
    // its schema-defining fields changed via this route. Keeps per-workflow
    // MCP consumers in sync without a dedicated version endpoint.
    if (
      willBeListed &&
      (body.nodes !== undefined ||
        body.edges !== undefined ||
        body.inputSchema !== undefined ||
        body.outputMapping !== undefined)
    ) {
      updateData.listingVersion = sql`${workflows.listingVersion} + 1`;
    }

    let updatedWorkflow: typeof workflows.$inferSelect;
    try {
      const [result] = await db
        .update(workflows)
        .set(updateData)
        .where(eq(workflows.id, workflowId))
        .returning();
      if (!result) {
        return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
      }
      updatedWorkflow = result;
    } catch (dbError) {
      const cause = dbError instanceof Error ? dbError.cause : undefined;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505") {
        return NextResponse.json(
          { error: "This slug is already in use. Choose a different slug." },
          { status: 400 }
        );
      }
      throw dbError;
    }

    await handlePostUpdateSideEffects(workflowId, body);

    return NextResponse.json({
      ...updatedWorkflow,
      createdAt: updatedWorkflow.createdAt.toISOString(),
      updatedAt: updatedWorkflow.updatedAt.toISOString(),
      isOwner: true,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to update workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update workflow",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { userId, organizationId } = authContext;

    const { hasAccess } = await validateWorkflowAccess(
      workflowId,
      userId,
      organizationId
    );

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Check for existing executions before deleting
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "true";

    const hasExecutions = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.workflowId, workflowId),
      columns: { id: true },
    });

    if (hasExecutions && !force) {
      return NextResponse.json(
        {
          error:
            "Workflow has execution history. Delete executions first before deleting the workflow.",
          hasExecutions: true,
        },
        { status: 409 }
      );
    }

    // If force delete, cascade delete logs, executions, and workflow in a transaction
    if (hasExecutions && force) {
      const { workflowExecutionLogs } = await import("@/lib/db/schema");
      const { inArray } = await import("drizzle-orm");

      await db.transaction(async (tx) => {
        const executions = await tx.query.workflowExecutions.findMany({
          where: eq(workflowExecutions.workflowId, workflowId),
          columns: { id: true },
        });

        const executionIds = executions.map((e) => e.id);

        if (executionIds.length > 0) {
          await tx
            .delete(workflowExecutionLogs)
            .where(inArray(workflowExecutionLogs.executionId, executionIds));

          await tx
            .delete(workflowExecutions)
            .where(eq(workflowExecutions.workflowId, workflowId));
        }

        await tx.delete(workflows).where(eq(workflows.id, workflowId));
      });
    } else {
      await db.delete(workflows).where(eq(workflows.id, workflowId));
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    // Handle FK constraint violation from race condition (execution inserted between check and delete)
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "23503") {
      return NextResponse.json(
        {
          error:
            "Workflow has execution history. Delete executions first before deleting the workflow.",
        },
        { status: 409 }
      );
    }

    logSystemError(ErrorCategory.DATABASE, "Failed to delete workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete workflow",
      },
      { status: 500 }
    );
  }
}
