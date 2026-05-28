import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invitation, organization, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  checkInviteFetchRateLimit,
  getInviteFetchRateLimitKey,
} from "../_lib/rate-limit";

type RouteParams = {
  params: Promise<{ inviteId: string }>;
};

// Invite details are tied to a single high-entropy bearer token; never cache
// them in shared or browser caches.
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/invitations/[inviteId]
 * Fetch invitation details by ID (public endpoint for accept-invite page)
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const rateLimit = checkInviteFetchRateLimit(
      getInviteFetchRateLimitKey(request)
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: {
            ...NO_STORE_HEADERS,
            "Retry-After": String(rateLimit.retryAfter),
          },
        }
      );
    }

    const { inviteId } = await params;

    if (!inviteId) {
      return NextResponse.json(
        { error: "Invitation ID is required" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // Fetch invitation with organization and inviter details
    const result = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        organizationId: invitation.organizationId,
        organizationName: organization.name,
        inviterName: users.name,
      })
      .from(invitation)
      .leftJoin(organization, eq(invitation.organizationId, organization.id))
      .leftJoin(users, eq(invitation.inviterId, users.id))
      .where(eq(invitation.id, inviteId))
      .limit(1);

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }

    const inv = result[0];

    // Check if invitation has expired
    if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) {
      return NextResponse.json(
        {
          error: "Invitation has expired",
          expired: true,
          invitation: {
            email: inv.email,
            organizationName: inv.organizationName,
          },
        },
        { status: 410, headers: NO_STORE_HEADERS }
      );
    }

    // Check if already accepted
    if (inv.status === "accepted") {
      return NextResponse.json(
        {
          error: "Invitation has already been accepted",
          alreadyAccepted: true,
          invitation: {
            email: inv.email,
            organizationName: inv.organizationName,
          },
        },
        { status: 410, headers: NO_STORE_HEADERS }
      );
    }

    // Check if rejected
    if (inv.status === "rejected") {
      return NextResponse.json(
        {
          error: "Invitation has been rejected",
          rejected: true,
          invitation: {
            email: inv.email,
            organizationName: inv.organizationName,
          },
        },
        { status: 410, headers: NO_STORE_HEADERS }
      );
    }

    // Return invitation details
    return NextResponse.json(
      {
        invitation: {
          id: inv.id,
          email: inv.email,
          role: inv.role,
          status: inv.status,
          expiresAt: inv.expiresAt,
          organizationName: inv.organizationName,
          inviterName: inv.inviterName || "A team member",
        },
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Invitation] Failed to fetch invitation",
      error,
      { endpoint: "/api/invitations/[inviteId]", operation: "fetch" }
    );
    return NextResponse.json(
      { error: "Failed to fetch invitation" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
