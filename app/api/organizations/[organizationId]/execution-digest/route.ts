import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  member,
  users,
  workflowExecutionDigestSettings,
} from "@/lib/db/schema";
import { isFeatureEnabledForOrg } from "@/lib/features/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { DIGEST_REQUIRES_SUBSCRIBER_ERROR } from "@/lib/notifications/digest-messages";
import { SUBSCRIBABLE_ROLES } from "@/lib/notifications/execution-digest";

const FEATURE_ID = "notifications.execution-digest" as const;

type ManagerOk = { ok: true; userId: string };
type ManagerErr = { ok: false; status: number; error: string };

// Owners and admins may view/manage the digest settings (matches who manages
// org membership). API-key callers are hard-scoped to their own org.
async function requireOrgManager(
  request: Request,
  organizationId: string
): Promise<ManagerOk | ManagerErr> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return { ok: false, status: authContext.status, error: authContext.error };
  }
  const { userId, organizationId: callerOrgId, authMethod } = authContext;
  if (!userId) {
    return { ok: false, status: 400, error: "Auth context missing user" };
  }
  if (authMethod === "api-key" && callerOrgId !== organizationId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, userId)
      )
    )
    .limit(1);

  if (!membership || !(membership.role === "owner" || membership.role === "admin")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, userId };
}

async function loadSettings(organizationId: string) {
  const [row] = await db
    .select({
      enabled: workflowExecutionDigestSettings.enabled,
      cadence: workflowExecutionDigestSettings.cadence,
      subscriberUserIds: workflowExecutionDigestSettings.subscriberUserIds,
    })
    .from(workflowExecutionDigestSettings)
    .where(eq(workflowExecutionDigestSettings.organizationId, organizationId))
    .limit(1);
  return row;
}

async function loadSubscribableMembers(organizationId: string) {
  return await db
    .select({
      userId: member.userId,
      role: member.role,
      email: users.email,
      name: users.name,
    })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.role, SUBSCRIBABLE_ROLES)
      )
    );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    const manager = await requireOrgManager(request, organizationId);
    if (!manager.ok) {
      return NextResponse.json(
        { error: manager.error },
        { status: manager.status }
      );
    }

    const [settings, members, eligible] = await Promise.all([
      loadSettings(organizationId),
      loadSubscribableMembers(organizationId),
      isFeatureEnabledForOrg(FEATURE_ID, organizationId),
    ]);

    return NextResponse.json({
      enabled: settings?.enabled ?? false,
      cadence: settings?.cadence ?? "weekly",
      subscriberUserIds: settings?.subscriberUserIds ?? [],
      eligible,
      members,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to load execution-digest settings",
      error,
      { endpoint: "/api/organizations/[organizationId]/execution-digest" }
    );
    return NextResponse.json(
      { error: "Failed to load settings" },
      { status: 500 }
    );
  }
}

type PutBody = {
  enabled?: boolean;
  cadence?: string;
  subscriberUserIds?: string[];
};

export async function PUT(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    const manager = await requireOrgManager(request, organizationId);
    if (!manager.ok) {
      return NextResponse.json(
        { error: manager.error },
        { status: manager.status }
      );
    }

    if (!(await isFeatureEnabledForOrg(FEATURE_ID, organizationId))) {
      return NextResponse.json(
        {
          error: "Execution digests require a paid plan.",
          code: "upgrade_required",
        },
        { status: 402 }
      );
    }

    const body = (await request.json()) as PutBody;
    const enabled = Boolean(body.enabled);
    const cadence = body.cadence === "daily" ? "daily" : "weekly";
    const requested = Array.isArray(body.subscriberUserIds)
      ? body.subscriberUserIds.filter((id): id is string => typeof id === "string")
      : [];

    // Keep only ids that are current owners/admins of this org.
    let subscriberUserIds: string[] = [];
    if (requested.length > 0) {
      const validRows = await db
        .select({ userId: member.userId })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            inArray(member.role, SUBSCRIBABLE_ROLES),
            inArray(member.userId, requested)
          )
        );
      const validSet = new Set(validRows.map((r) => r.userId));
      subscriberUserIds = requested.filter((id) => validSet.has(id));
    }

    // A digest with no recipients would send to nobody; require at least one
    // valid subscriber when enabling.
    if (enabled && subscriberUserIds.length === 0) {
      return NextResponse.json(
        { error: DIGEST_REQUIRES_SUBSCRIBER_ERROR },
        { status: 400 }
      );
    }

    const now = new Date();
    await db
      .insert(workflowExecutionDigestSettings)
      .values({
        organizationId,
        enabled,
        cadence,
        subscriberUserIds,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workflowExecutionDigestSettings.organizationId,
        set: { enabled, cadence, subscriberUserIds, updatedAt: now },
      });

    return NextResponse.json({ enabled, cadence, subscriberUserIds });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to save execution-digest settings",
      error,
      { endpoint: "/api/organizations/[organizationId]/execution-digest" }
    );
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
