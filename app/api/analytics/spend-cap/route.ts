import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSpendCapData } from "@/lib/analytics/queries";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { organizationSpendCaps } from "@/lib/db/schema";
import {
  requireOrganization,
  requirePermission,
} from "@/lib/middleware/require-org";

const NON_NEGATIVE_INTEGER = /^\d+$/;

export const GET = requireOrganization(
  async (_req: NextRequest, context): Promise<Response> => {
    const organizationId = context.organization?.id;
    if (!organizationId) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 403 }
      );
    }

    try {
      const data = await getSpendCapData(organizationId);
      return NextResponse.json(data);
    } catch (error: unknown) {
      return apiError(error, "Failed to fetch spend cap data");
    }
  }
);

/**
 * Set or clear the organization's daily value cap (native wei).
 *
 * Gated by `organization:update` (admin/owner) over the session. A leaked `kh_`
 * API key or MCP OAuth token authenticates a different layer and never satisfies
 * the org session context, so a compromised key cannot raise its own ceiling.
 * A null `dailyValueCapWei` clears the cap (unlimited).
 */
export const PUT = requirePermission(
  "organization",
  ["update"],
  async (req: NextRequest, context): Promise<Response> => {
    const organizationId = context.organization?.id;
    if (!organizationId) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 403 }
      );
    }

    let body: { dailyValueCapWei?: unknown };
    try {
      body = (await req.json()) as { dailyValueCapWei?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const raw = body.dailyValueCapWei;
    let dailyValueCapWei: string | null;
    if (raw === null) {
      dailyValueCapWei = null;
    } else if (typeof raw === "string" && NON_NEGATIVE_INTEGER.test(raw)) {
      dailyValueCapWei = raw;
    } else {
      return NextResponse.json(
        {
          error:
            "dailyValueCapWei must be a non-negative integer wei string, or null to clear the cap",
          field: "dailyValueCapWei",
        },
        { status: 400 }
      );
    }

    try {
      await db
        .insert(organizationSpendCaps)
        .values({ organizationId, dailyValueCapWei })
        .onConflictDoUpdate({
          target: organizationSpendCaps.organizationId,
          set: { dailyValueCapWei, updatedAt: new Date() },
        });
    } catch (error: unknown) {
      return apiError(error, "Failed to update spend cap");
    }

    return NextResponse.json({ dailyValueCapWei }, { status: 200 });
  }
);
