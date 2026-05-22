import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { VerifyMfaForm } from "./verify-mfa-form";

/**
 * Step-up MFA verification page. Sessions whose login-risk check flagged
 * a new-country sign-in are minted with sessions.requires_mfa = true and
 * the rest of the app refuses to render until the user proves a TOTP
 * code here. On success the API clears the flag and the user is sent on
 * to the destination they were originally heading for (when provided
 * via the `next` query param).
 */
export default async function VerifyMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<React.ReactElement> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    redirect("/");
  }

  const sessionRow = session.session as { requiresMfa?: boolean };
  if (sessionRow.requiresMfa !== true) {
    redirect("/");
  }

  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "/";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <VerifyMfaForm next={next} />
    </main>
  );
}
