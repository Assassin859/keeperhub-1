import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { decryptUserShare } from "@/lib/encryption";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { getOrganizationWallet } from "@/lib/para/wallet-helpers";

export async function GET(request: Request): Promise<NextResponse> {
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
        { error: "Only admins and owners can access wallet shares" },
        { status: 403 }
      );
    }

    const wallet = await getOrganizationWallet(activeOrgId);

    if (!wallet.userShare) {
      return NextResponse.json(
        { error: "This wallet does not have a user share (non-Para wallet)" },
        { status: 400 }
      );
    }

    const decryptedShare = decryptUserShare(wallet.userShare);

    return NextResponse.json({ userShare: decryptedShare });
  } catch (error) {
    return apiError(error, "Failed to get wallet share");
  }
}
