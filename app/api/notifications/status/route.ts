import { and, count, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  getPlanLimits,
  parsePlanName,
  parseTierKey,
} from "@/lib/billing/plans";
import { getOrgSubscription } from "@/lib/billing/plans-server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  auditFromAuth,
  type OrganizationAuthContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";

export type NotificationType = "billing_limit_reached";

type NotificationStatusResponse = {
  unreadCount: number;
  types: NotificationType[];
};

export async function GET(
  request: Request
): Promise<NextResponse<NotificationStatusResponse | { error: string }>> {
  let authContext: OrganizationAuthContext | null = null;
  try {
    authContext = await resolveOrganizationId(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { organizationId } = authContext;

    const types: NotificationType[] = [];

    if (isBillingEnabled()) {
      const billingLimitReached = await isBillingLimitReached(organizationId);
      if (billingLimitReached) {
        types.push("billing_limit_reached");
      }
    }

    return NextResponse.json({ unreadCount: types.length, types });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Notifications] Status query error",
      error,
      {
        endpoint: "/api/notifications/status",
        operation: "get",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      { error: "Failed to fetch notifications" },
      { status: 500 }
    );
  }
}

async function isBillingLimitReached(organizationId: string): Promise<boolean> {
  const sub = await getOrgSubscription(organizationId);
  const plan = parsePlanName(sub?.plan);
  const tier = parseTierKey(sub?.tier);
  const limits = getPlanLimits(plan, tier, sub?.planOverrides);

  if (limits.maxExecutionsPerMonth < 0) {
    return false;
  }

  const enabledWorkflowsResult = await db
    .select({ value: count() })
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        eq(workflows.enabled, true)
      )
    );
  const enabledWorkflows = enabledWorkflowsResult[0]?.value ?? 0;
  if (enabledWorkflows === 0) {
    return false;
  }

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const usageResult = await db.execute<{ count: number }>(
    sql`SELECT
          (
            SELECT COUNT(*)
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE w.organization_id = ${organizationId}
               AND we.started_at >= ${startOfMonth.toISOString()}
               AND we.status <> 'blocked_billing'
          )
          +
          (
            SELECT COUNT(*)
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
               AND de.created_at >= ${startOfMonth.toISOString()}
               AND de.status <> 'blocked_billing'
          ) AS count`
  );
  const used = usageResult[0]?.count ?? 0;
  return used >= limits.maxExecutionsPerMonth;
}
