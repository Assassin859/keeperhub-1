import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { organizationWallets } from "../lib/db/schema";

type Db = ReturnType<typeof drizzle>;

/**
 * If any org has an active Turnkey wallet, the executor pod (and by extension
 * the runner Jobs it spawns via RUNNER_SYSTEM_ENV_VARS forwarding) must have
 * TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY set. Fail at startup
 * instead of per-job so the regression surfaces on deploy, not on the first
 * Turnkey-backed workflow run.
 */
export async function assertTurnkeyEnvForActiveWallets(db: Db): Promise<void> {
  const rows = await db
    .select({ id: organizationWallets.id })
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.provider, "turnkey"),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  if (rows.length === 0) {
    return;
  }

  const missing: string[] = [];
  if (!process.env.TURNKEY_API_PUBLIC_KEY) {
    missing.push("TURNKEY_API_PUBLIC_KEY");
  }
  if (!process.env.TURNKEY_API_PRIVATE_KEY) {
    missing.push("TURNKEY_API_PRIVATE_KEY");
  }

  if (missing.length > 0) {
    throw new Error(
      `Active Turnkey wallets exist but required env vars are unset: ${missing.join(", ")}. ` +
        "Set these on the executor deployment so they forward to workflow runner Jobs."
    );
  }
}
