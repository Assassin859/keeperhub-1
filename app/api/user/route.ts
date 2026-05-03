import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  auditFromAuth,
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { getUserWallet } from "@/lib/para/wallet-helpers";

export async function GET(request: Request): Promise<NextResponse> {
  let authContext: DualAuthContext | null = null;
  try {
    authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId } = authContext;
    if (!userId) {
      return NextResponse.json(
        { error: "Auth context missing user. Please recreate the API key." },
        { status: 400 }
      );
    }

    const userData = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        name: true,
        email: true,
        image: true,
        isAnonymous: true,
      },
    });

    if (!userData) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userAccount = await db.query.accounts.findFirst({
      where: eq(accounts.userId, userId),
      columns: {
        providerId: true,
      },
    });

    let walletAddress: string | null = null;
    try {
      const wallet = await getUserWallet(userId);
      walletAddress = wallet.walletAddress;
    } catch {
      walletAddress = null;
    }

    return NextResponse.json({
      ...userData,
      providerId: userAccount?.providerId ?? null,
      walletAddress,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get user", error, {
      endpoint: "/api/user",
      operation: "get",
      ...auditFromAuth(authContext),
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get user",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is an OAuth user (can't update profile)
    const userAccount = await db.query.accounts.findFirst({
      where: eq(accounts.userId, session.user.id),
      columns: {
        providerId: true,
      },
    });

    // Block updates for OAuth users (github, google, etc.)
    const oauthProviders = ["github", "google"];
    if (userAccount && oauthProviders.includes(userAccount.providerId)) {
      return NextResponse.json(
        { error: "Cannot update profile for OAuth users" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const updates: { name?: string; email?: string } = {};

    if (body.name !== undefined) {
      updates.name = body.name;
    }
    if (body.email !== undefined) {
      updates.email = body.email;
    }

    await db.update(users).set(updates).where(eq(users.id, session.user.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to update user", error, {
      endpoint: "/api/user",
      operation: "update",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update user",
      },
      { status: 500 }
    );
  }
}
