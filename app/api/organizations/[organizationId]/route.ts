import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

type UpdateOrganizationNameRequest = {
  name?: string;
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId: callerOrgId } = authContext;
    if (!userId) {
      return NextResponse.json(
        { error: "Auth context missing user. Please recreate the API key." },
        { status: 400 }
      );
    }

    // Hard-scope API key callers to their own org. The owner-membership query
    // below would already 403 a cross-org call (the key creator is not a
    // member of an unrelated org), but rejecting upfront makes the intent
    // explicit and avoids leaking whether the URL org exists.
    if (callerOrgId && callerOrgId !== organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await request.json()) as UpdateOrganizationNameRequest;
    const nextName =
      typeof body.name === "string" ? body.name.trim() : undefined;

    if (!nextName) {
      return NextResponse.json(
        { error: "Organization name is required" },
        { status: 400 }
      );
    }

    if (nextName.length > 120) {
      return NextResponse.json(
        { error: "Organization name is too long" },
        { status: 400 }
      );
    }

    const ownerMembership = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
          eq(member.role, "owner")
        )
      )
      .limit(1);

    if (ownerMembership.length === 0) {
      return NextResponse.json(
        { error: "Only organization owners can update the organization" },
        { status: 403 }
      );
    }

    const [updated] = await db
      .update(organization)
      .set({ name: nextName })
      .where(eq(organization.id, organizationId))
      .returning({ id: organization.id, name: organization.name });

    if (!updated) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ organization: updated }, { status: 200 });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to update organization",
      error,
      { endpoint: "/api/organizations/[organizationId]", operation: "update" }
    );
    return NextResponse.json(
      { error: "Failed to update organization" },
      { status: 500 }
    );
  }
}
