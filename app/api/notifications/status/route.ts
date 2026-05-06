import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { isBillingLimitReached } from "@/lib/billing/limit-status";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";

export type NotificationType = "billing_limit_reached";

type NotificationStatusResponse = {
  unreadCount: number;
  types: NotificationType[];
};

const EMPTY_RESPONSE: NotificationStatusResponse = {
  unreadCount: 0,
  types: [],
};

export async function GET(
  request: Request
): Promise<NextResponse<NotificationStatusResponse>> {
  try {
    const authContext = await resolveOrganizationId(request);
    if ("error" in authContext) {
      return NextResponse.json(EMPTY_RESPONSE);
    }
    const { organizationId } = authContext;

    const types: NotificationType[] = [];

    if (isBillingEnabled() && (await isBillingLimitReached(organizationId))) {
      types.push("billing_limit_reached");
    }

    return NextResponse.json({ unreadCount: types.length, types });
  } catch (error) {
    console.warn(
      "[notifications-status] degraded; returning empty response",
      error
    );
    return NextResponse.json(EMPTY_RESPONSE);
  }
}
