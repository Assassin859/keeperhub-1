/**
 * Reset MFA for a local user.
 *
 *   pnpm tsx scripts/miscellaneous/reset-mfa.ts <email>
 *
 * Deletes the user's two_factor row, clears users.two_factor_enabled,
 * and wipes any in-flight verifications for that user. Intended for
 * local re-enrollment testing only. Refuses to run against a hostname
 * that doesn't look like localhost as a guardrail.
 */

import { and, eq, like } from "drizzle-orm";
import { db } from "../../lib/db";
import { twoFactor, users, verifications } from "../../lib/db/schema";

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1|::1|host\.docker\.internal/.test(url)) {
    console.error(
      `Refusing to run: DATABASE_URL does not look local (${url || "unset"}).`
    );
    process.exit(1);
  }
}

async function resetMfa(email: string): Promise<void> {
  assertLocalDatabase();

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  console.log(`Resetting MFA for ${user.email} (${user.id})`);

  const tfDeleted = await db
    .delete(twoFactor)
    .where(eq(twoFactor.userId, user.id))
    .returning({ id: twoFactor.id });
  console.log(`  two_factor rows removed: ${tfDeleted.length}`);

  const updated = await db
    .update(users)
    .set({ twoFactorEnabled: false, updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .returning({ id: users.id });
  console.log(`  users.two_factor_enabled cleared: ${updated.length}`);

  // mfa:<action>:<userId> identifiers from lib/mfa/dual-factor.ts.
  const inflight = await db
    .delete(verifications)
    .where(
      and(
        like(verifications.identifier, "mfa:%"),
        like(verifications.identifier, `%:${user.id}`)
      )
    )
    .returning({ id: verifications.id });
  console.log(`  in-flight dual-factor verifications cleared: ${inflight.length}`);

  console.log("Done. Sign in again to re-enroll TOTP.");
  process.exit(0);
}

const [, , email] = process.argv;
if (!email) {
  console.error(
    "Usage: pnpm tsx scripts/miscellaneous/reset-mfa.ts <email>"
  );
  process.exit(1);
}

resetMfa(email);
