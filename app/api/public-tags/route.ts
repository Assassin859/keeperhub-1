import { count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publicTags, workflowPublicTags } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function GET(): Promise<NextResponse> {
  try {
    const allTags = await db
      .select({
        id: publicTags.id,
        name: publicTags.name,
        slug: publicTags.slug,
        createdAt: publicTags.createdAt,
        workflowCount: count(workflowPublicTags.workflowId),
      })
      .from(publicTags)
      .leftJoin(
        workflowPublicTags,
        eq(workflowPublicTags.publicTagId, publicTags.id)
      )
      .groupBy(publicTags.id)
      .orderBy(publicTags.name);

    const response = allTags.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
    }));

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[PublicTags] Failed to list public tags",
      error,
      { endpoint: "/api/public-tags", operation: "list" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list public tags",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const body = await request.json().catch(() => ({}));
    const name = body.name?.trim();

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const slug = slugify(name);

    if (!slug) {
      return NextResponse.json({ error: "Invalid tag name" }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(publicTags)
      .where(eq(publicTags.slug, slug))
      .limit(1);

    if (existing) {
      return NextResponse.json({
        ...existing,
        workflowCount: 0,
        createdAt: existing.createdAt.toISOString(),
      });
    }

    const [newTag] = await db
      .insert(publicTags)
      .values({ name, slug })
      .returning();

    return NextResponse.json(
      {
        ...newTag,
        workflowCount: 0,
        createdAt: newTag.createdAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[PublicTags] Failed to create public tag",
      error,
      { endpoint: "/api/public-tags", operation: "create" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create public tag",
      },
      { status: 500 }
    );
  }
}
