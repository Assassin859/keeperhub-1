import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const authContext = await getDualAuthContext(request, { required: false });
    if ("error" in authContext) {
      return authFailureResponse(authContext, request.headers);
    }

    const { organizationId } = authContext;

    // A caller who presented a Bearer credential and got no principal back had
    // it refused. Answering 200 with an empty list tells an MCP client "nothing
    // here" instead of "reauthenticate", so a revoked or rescoped connection
    // goes quiet and never refreshes. Anonymous callers, who send no
    // credential, keep the empty list.
    if (!organizationId && request.headers.get("Authorization")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The org owns every workflow; the list is purely org-scoped.
    if (!organizationId) {
      return NextResponse.json([], { status: 200 });
    }

    const { searchParams } = new URL(request.url);
    const projectIdFilter = searchParams.get("projectId");
    const tagIdFilter = searchParams.get("tagId");

    const conditions = [eq(workflows.organizationId, organizationId)];

    if (projectIdFilter) {
      conditions.push(eq(workflows.projectId, projectIdFilter));
    }
    if (tagIdFilter) {
      conditions.push(eq(workflows.tagId, tagIdFilter));
    }

    const userWorkflows = await db
      .select()
      .from(workflows)
      .where(and(...conditions))
      .orderBy(asc(workflows.createdAt));

    const mappedWorkflows = userWorkflows.map((workflow) => ({
      ...workflow,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    }));

    return NextResponse.json(mappedWorkflows);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get workflows", error, {
      endpoint: "/api/workflows",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get workflows",
      },
      { status: 500 }
    );
  }
}
