import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { EnrollMfaForm } from "./enroll-mfa-form";

/**
 * Forced TOTP enrollment page. Sessions whose user has
 * users.two_factor_enabled = false are routed here by the root proxy and
 * cannot reach the rest of the app until enrollment completes. On
 * successful enrollment the API flips two_factor_enabled = true and
 * users.totp_verified_at is set; the next request through the proxy
 * sees the new state and the redirect lifts.
 */
export default async function EnrollMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<React.ReactElement> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    redirect("/");
  }
  const user = session.user as { twoFactorEnabled?: boolean | null };
  if (user.twoFactorEnabled === true) {
    redirect("/");
  }

  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "/";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <EnrollMfaForm next={next} />
    </main>
  );
}
