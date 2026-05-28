/**
 * Print the live email OTP(s) for a user from the local DB.
 *
 *   pnpm tsx scripts/miscellaneous/peek-email-otp.ts <email>
 *
 * For local dev where email delivery is not wired up. Reads the
 * verifications table, decrypts `value` with BETTER_AUTH_SECRET via
 * better-auth's symmetricDecrypt (same primitive as
 * lib/mfa/dual-factor.ts and the emailOTP plugin). Prints every
 * non-expired row matching the user so you can see whichever flow
 * minted the code (dual-factor stepup, sign-up verification, etc.).
 */

import { symmetricDecrypt } from "better-auth/crypto";
import { eq, gt } from "drizzle-orm";
import { db } from "../../lib/db";
import { users, verifications } from "../../lib/db/schema";

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1|::1|host\.docker\.internal/.test(url)) {
    console.error(
      `Refusing to run: DATABASE_URL does not look local (${url || "unset"}).`
    );
    process.exit(1);
  }
}

async function decryptValue(value: string): Promise<string> {
  const key = process.env.BETTER_AUTH_SECRET;
  if (!key) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }
  return await symmetricDecrypt({ key, data: value });
}

async function peek(email: string): Promise<void> {
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

  // Pull every non-expired verification row, then filter to ones that
  // belong to this user. Better Auth's emailOTP plugin keys identifier
  // by email (e.g. "email-otp-<email>"); dual-factor keys by user id
  // ("mfa:<action>:<userId>"). Match both shapes.
  const now = new Date();
  const rows = await db
    .select()
    .from(verifications)
    .where(gt(verifications.expiresAt, now));

  const mine = rows.filter((r) => {
    if (r.identifier.includes(user.id)) {
      return true;
    }
    if (r.identifier.includes(user.email ?? "")) {
      return true;
    }
    return false;
  });

  if (mine.length === 0) {
    console.log(`No live verification rows for ${user.email} (${user.id}).`);
    process.exit(0);
  }

  for (const row of mine) {
    let plaintext: string;
    try {
      plaintext = await decryptValue(row.value);
    } catch (err) {
      plaintext = `<decrypt failed: ${(err as Error).message}>`;
    }
    console.log("---");
    console.log(`  identifier : ${row.identifier}`);
    console.log(`  expires_at : ${row.expiresAt.toISOString()}`);
    console.log(`  otp        : ${plaintext}`);
  }
  process.exit(0);
}

const [, , email] = process.argv;
if (!email) {
  console.error(
    "Usage: pnpm tsx scripts/miscellaneous/peek-email-otp.ts <email>"
  );
  process.exit(1);
}

peek(email);
