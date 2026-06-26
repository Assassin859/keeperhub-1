import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import {
  twoFactor as twoFactorTable,
  users,
  walletAddress,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  parseStepUpPolicy,
  type StepUpFactor,
  type StepUpPolicy,
} from "@/lib/mfa/step-up-policy";
import { requireStepUp, stepUpErrorResponse } from "@/lib/mfa/wallet-step-up";

const VALID_FACTORS: StepUpFactor[] = ["totp", "email"];

type EnrolledFactors = { wallet: boolean; totp: boolean; email: boolean };

async function loadEnrolled(
  userId: string,
  stepUpEmail: string | null
): Promise<EnrolledFactors> {
  const [[wallet], [tf]] = await Promise.all([
    db
      .select({ id: walletAddress.id })
      .from(walletAddress)
      .where(eq(walletAddress.userId, userId))
      .limit(1),
    db
      .select({ id: twoFactorTable.id })
      .from(twoFactorTable)
      .where(eq(twoFactorTable.userId, userId))
      .limit(1),
  ]);
  return {
    wallet: Boolean(wallet),
    totp: Boolean(tf),
    email: Boolean(stepUpEmail),
  };
}

// GET: current per-action policy + which factors the user has enrolled, so the
// settings UI can render the toggles.
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [row] = await db
    .select({
      stepUpPolicy: users.stepUpPolicy,
      stepUpEmail: users.stepUpEmail,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const enrolled = await loadEnrolled(
    session.user.id,
    row?.stepUpEmail ?? null
  );
  return NextResponse.json({
    walletUser: isWalletEmail(session.user.email),
    policy: parseStepUpPolicy(row?.stepUpPolicy),
    enrolled,
  });
}

// PUT: set the extra factors for one action. Adding a factor (strengthening)
// is free; removing one (weakening) requires passing step-up first, so a
// hijacked session can't quietly lower protection.
export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Email/TOTP users always use mandatory dual-factor; only wallet users
    // configure their per-action policy.
    if (!isWalletEmail(session.user.email)) {
      return NextResponse.json(
        { error: "Only wallet accounts can configure step-up." },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      factors?: unknown;
      signature?: string;
      code?: string;
      emailOtp?: string;
    };
    const action = typeof body.action === "string" ? body.action : "";
    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }
    const nextFactors = Array.isArray(body.factors)
      ? (body.factors.filter(
          (f): f is StepUpFactor =>
            typeof f === "string" && VALID_FACTORS.includes(f as StepUpFactor)
        ) as StepUpFactor[])
      : [];

    const [row] = await db
      .select({
        stepUpPolicy: users.stepUpPolicy,
        stepUpEmail: users.stepUpEmail,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    const policy = parseStepUpPolicy(row?.stepUpPolicy);
    const current = new Set(policy[action] ?? []);
    const next = new Set(nextFactors);

    // Can't require a factor the user hasn't enrolled.
    const enrolled = await loadEnrolled(
      session.user.id,
      row?.stepUpEmail ?? null
    );
    for (const factor of next) {
      if (factor === "totp" && !enrolled.totp) {
        return NextResponse.json(
          { error: "Enroll an authenticator before requiring it." },
          { status: 400 }
        );
      }
      if (factor === "email" && !enrolled.email) {
        return NextResponse.json(
          { error: "Add a verified email before requiring it." },
          { status: 400 }
        );
      }
    }

    // Weakening = removing any currently-required factor.
    const isWeakening = [...current].some((f) => !next.has(f));
    if (isWeakening) {
      const stepUp = await requireStepUp({
        userId: session.user.id,
        email: session.user.email,
        action: "step_up_policy_change",
        signature: body.signature,
        code: body.code,
        emailOtp: body.emailOtp,
        headers: request.headers,
      });
      if (!stepUp.ok) {
        return stepUpErrorResponse(stepUp);
      }
    }

    // Always store the resolved factor list, including an empty array: for a
    // default-on action (withdraw / export-key) an empty array is the user's
    // explicit opt-out, which must persist instead of falling back to the
    // default. For other actions an empty array is equivalent to absent.
    const updated: StepUpPolicy = { ...policy, [action]: [...next] };
    await db
      .update(users)
      .set({ stepUpPolicy: updated, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));

    return NextResponse.json({ success: true, policy: updated });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to update step-up policy",
      error,
      { endpoint: "/api/user/step-up/policy" }
    );
    return NextResponse.json(
      { error: "Failed to update step-up policy." },
      { status: 500 }
    );
  }
}
