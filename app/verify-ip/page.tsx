import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  decodePendingIpCookie,
  readPendingIpCookie,
} from "@/lib/pending-ip-cookie";
import { formatIpForDisplay } from "@/lib/security/ip-normalize";
import { VerifyIpForm } from "./verify-ip-form";

/**
 * Locked dual-factor prompt for sign-ins that arrived from a
 * network the user has never used. The user has just satisfied
 * password + email OTP + TOTP at strict-signin (or TOTP at the
 * OAuth callback) but no session row exists yet; only a signed
 * `pending_ip_verify` cookie identifies them. Verifying email +
 * TOTP again here against the very same IP mints the session for
 * the first time and records the IP as trusted.
 *
 * If the cookie is missing, tampered, or expired the user has
 * nothing to verify against, so we bounce them to the home page
 * where the standard sign-in flow can take over.
 */
export default async function VerifyIpPage(): Promise<React.ReactElement> {
  const requestHeaders = await headers();
  const cookieValue = readPendingIpCookie(requestHeaders);
  if (!cookieValue) {
    redirect("/");
  }
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    redirect("/");
  }
  const decoded = decodePendingIpCookie(cookieValue, secret);
  if (!decoded.ok) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <VerifyIpForm
        country={decoded.payload.country}
        email={decoded.payload.email}
        ip={formatIpForDisplay(decoded.payload.ip)}
        next={decoded.payload.redirect || "/"}
      />
    </main>
  );
}
