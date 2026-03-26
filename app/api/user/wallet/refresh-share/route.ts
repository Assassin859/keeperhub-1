import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { paraWallets } from "@/lib/db/schema";
import { encryptUserShare } from "@/lib/encryption";
import { getActiveOrgId } from "@/lib/middleware/org-context";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const activeOrgId = getActiveOrgId(session);
    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const activeMember = await auth.api.getActiveMember({
      headers: await headers(),
    });

    if (!activeMember) {
      return NextResponse.json(
        { error: "You are not a member of the active organization" },
        { status: 403 }
      );
    }

    if (activeMember.role !== "admin" && activeMember.role !== "owner") {
      return NextResponse.json(
        { error: "Only admins and owners can refresh wallet shares" },
        { status: 403 }
      );
    }

    const body: { userShare?: string } = await request.json();
    const { userShare } = body;

    if (!userShare || typeof userShare !== "string") {
      return NextResponse.json(
        { error: "userShare is required" },
        { status: 400 }
      );
    }

    const MIN_USER_SHARE_LENGTH = 100;
    const MAX_USER_SHARE_LENGTH = 10_000;

    if (
      userShare.length < MIN_USER_SHARE_LENGTH ||
      userShare.length > MAX_USER_SHARE_LENGTH
    ) {
      return NextResponse.json(
        { error: "Invalid userShare: unexpected length" },
        { status: 400 }
      );
    }

    const encryptedShare = encryptUserShare(userShare);

    const updated = await db
      .update(paraWallets)
      .set({ userShare: encryptedShare })
      .where(eq(paraWallets.organizationId, activeOrgId))
      .returning({ id: paraWallets.id });

    if (updated.length === 0) {
      return NextResponse.json(
        { error: "No wallet found for this organization" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error, "Failed to refresh wallet share");
  }
}
