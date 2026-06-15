import { and, count, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tags, workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  resolveCreatorContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId } = authCtx;

    const orgTags = await db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        organizationId: tags.organizationId,
        userId: tags.userId,
        createdAt: tags.createdAt,
        updatedAt: tags.updatedAt,
        workflowCount: count(workflows.id),
      })
      .from(tags)
      .leftJoin(
        workflows,
        and(eq(workflows.tagId, tags.id), ne(workflows.name, "__current__"))
      )
      .where(eq(tags.organizationId, organizationId))
      .groupBy(tags.id)
      .orderBy(tags.name);

    const response = orgTags.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to list tags", error, {
      endpoint: "/api/tags",
      operation: "get",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to list tags",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const resolved = await resolveCreatorContext(request);
    if ("error" in resolved) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }
    const scopeError = requireScope(resolved.scope, SCOPE_MCP_WRITE);
    if (scopeError) {
      return scopeError;
    }
    const { organizationId, userId: creatorUserId } = resolved;

    const body = await request.json().catch(() => ({}));
    const name = body.name?.trim();

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!body.color) {
      return NextResponse.json({ error: "Color is required" }, { status: 400 });
    }

    const [newTag] = await db
      .insert(tags)
      .values({
        name,
        color: body.color,
        organizationId,
        userId: creatorUserId,
      })
      .returning();

    return NextResponse.json(
      {
        ...newTag,
        workflowCount: 0,
        createdAt: newTag.createdAt.toISOString(),
        updatedAt: newTag.updatedAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to create tag", error, {
      endpoint: "/api/tags",
      operation: "post",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to create tag",
      },
      { status: 500 }
    );
  }
}
