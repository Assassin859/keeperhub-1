import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { truncateAddress } from "@/lib/address-utils";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { integrations, organizationWallets } from "@/lib/db/schema";
import { getActiveOrgId } from "@/lib/middleware/org-context";

type ValidationResult =
  | { error: string; status: number }
  | { organizationId: string };

async function validateAdmin(request: Request): Promise<ValidationResult> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }
  const activeOrgId = getActiveOrgId(session);
  if (!activeOrgId) {
    return { error: "No active organization", status: 400 };
  }
  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });
  if (!activeMember) {
    return { error: "Not a member of the active organization", status: 403 };
  }
  if (activeMember.role !== "admin" && activeMember.role !== "owner") {
    return {
      error: "Only admins and owners can switch the active wallet",
      status: 403,
    };
  }
  return { organizationId: activeOrgId };
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const validation = await validateAdmin(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { organizationId } = validation;

    const body = (await request.json()) as { walletId?: string };
    const walletId = body.walletId;
    if (!walletId || typeof walletId !== "string") {
      return NextResponse.json(
        { error: "walletId is required" },
        { status: 400 }
      );
    }

    const target = await db
      .select({
        id: organizationWallets.id,
        walletAddress: organizationWallets.walletAddress,
      })
      .from(organizationWallets)
      .where(
        and(
          eq(organizationWallets.id, walletId),
          eq(organizationWallets.organizationId, organizationId)
        )
      )
      .limit(1);

    if (target.length === 0) {
      return NextResponse.json(
        { error: "Wallet not found for this organization" },
        { status: 404 }
      );
    }

    const newDisplayName = truncateAddress(target[0].walletAddress);

    // Flip in two steps inside a transaction so the partial unique index
    // `(organization_id) WHERE is_active = true` never sees two active rows
    // simultaneously: first deactivate all, then activate the target.
    // The web3 integration row's `name` caches the active wallet's truncated
    // address for display on workflow nodes; keep it in sync here so the UI
    // reflects the flip without a manual refresh or stale-cache hit.
    await db.transaction(async (tx) => {
      await tx
        .update(organizationWallets)
        .set({ isActive: false })
        .where(eq(organizationWallets.organizationId, organizationId));

      await tx
        .update(organizationWallets)
        .set({ isActive: true })
        .where(eq(organizationWallets.id, walletId));

      await tx
        .update(integrations)
        .set({ name: newDisplayName })
        .where(
          and(
            eq(integrations.organizationId, organizationId),
            eq(integrations.type, "web3")
          )
        );
    });

    return NextResponse.json({ success: true, walletId });
  } catch (error) {
    return apiError(error, "Failed to switch active wallet");
  }
}
