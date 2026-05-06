import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { isBillingLimitReached } from "@/lib/billing/limit-status";
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

    if (isBillingEnabled() && (await isBillingLimitReached(organizationId))) {
      types.push("billing_limit_reached");
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
