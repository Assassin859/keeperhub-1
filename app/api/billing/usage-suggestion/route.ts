import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getUpgradeSuggestion } from "@/lib/billing/tier-suggestions";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  type AuthAuditLabels,
  UNAUTHENTICATED_AUDIT,
  auditFromAuth,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let audit: AuthAuditLabels = { ...UNAUTHENTICATED_AUDIT };
  try {
    const authContext = await resolveOrganizationId(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    audit = auditFromAuth(authContext);
    const { organizationId } = authContext;

    const suggestion = await getUpgradeSuggestion(organizationId);
    return NextResponse.json(suggestion);
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Usage suggestion error",
      error,
      {
        endpoint: "/api/billing/usage-suggestion",
        operation: "get",
        ...audit,
      }
    );
    return NextResponse.json(
      { error: "Failed to fetch usage suggestion" },
      { status: 500 }
    );
  }
}
