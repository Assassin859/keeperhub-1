import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import {
  checkWalletOrgMfaCompliance,
  getEnrolledFactors,
} from "@/lib/mfa/org-mfa-enforcement";
import { sanitizeNextPath } from "@/lib/sanitize-next-path";
import { EnforceMfaForm } from "./enforce-mfa-form";

/**
 * Hard gate for wallet (SIWE) members whose active org enforces MFA. The proxy
 * routes them here on every request until they enroll a factor the org
 * accepts. Email/TOTP users never reach this page; their dual-factor gate lives
 * at /enroll-mfa and /verify-mfa.
 */
export default async function EnforceMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<React.ReactElement> {
  const requestHeaders = await headers();
  const next = sanitizeNextPath((await searchParams).next);

  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    redirect("/");
  }
  if (!isWalletEmail(session.user.email)) {
    redirect(next || "/");
  }

  const activeOrganizationId = (
    session.session as { activeOrganizationId?: string | null }
  ).activeOrganizationId;

  const { compliant, required } = await checkWalletOrgMfaCompliance({
    userId: session.user.id,
    activeOrganizationId,
  });
  if (compliant) {
    redirect(next || "/");
  }

  const [[org], enrolled] = await Promise.all([
    activeOrganizationId
      ? db
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, activeOrganizationId))
          .limit(1)
      : Promise.resolve([]),
    getEnrolledFactors(session.user.id),
  ]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <EnforceMfaForm
        enrolled={enrolled}
        next={next || "/"}
        orgName={org?.name ?? "your organization"}
        required={required}
      />
    </main>
  );
}
