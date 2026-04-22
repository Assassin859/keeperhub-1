/**
 * Provision a Turnkey wallet for every organization that currently holds a
 * Para wallet but no Turnkey one, reusing the Para wallet's email.
 *
 * The new Turnkey wallet is inserted with is_active = false so signing paths
 * keep using Para until an admin explicitly flips the switch in the Wallet
 * overlay.
 *
 * Runs idempotently: orgs that already have a Turnkey wallet are skipped.
 *
 * Concurrency: invoked from every pod's init container. A Postgres advisory
 * lock guarantees only one runner does the work; the others exit cleanly.
 *
 * Usage:
 *   npx tsx scripts/provision-turnkey-for-para-orgs.ts
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { normalizeAddressForStorage } from "../lib/address-utils";
import * as schema from "../lib/db/schema";
import { createTurnkeyWallet } from "../lib/turnkey/turnkey-operations";

// Stable key for pg_try_advisory_lock. Any constant unique to this task works;
// keep it out of the range used by other advisory locks in the project.
const ADVISORY_LOCK_KEY = 923_102_301 as const;

type ProvisionSummary = {
  provisioned: number;
  skipped: number;
  failed: number;
};

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 2 });
  const db = drizzle(client, { schema });

  try {
    const [lockRow] = await db.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) as acquired`
    );
    if (!lockRow?.acquired) {
      console.log(
        "[provision-turnkey] Another runner holds the advisory lock; exiting."
      );
      return;
    }

    const { organizationWallets } = schema;

    const paraWallets = await db
      .select({
        id: organizationWallets.id,
        userId: organizationWallets.userId,
        organizationId: organizationWallets.organizationId,
        email: organizationWallets.email,
      })
      .from(organizationWallets)
      .where(eq(organizationWallets.provider, "para"));

    const turnkeyOrgIds = new Set(
      (
        await db
          .select({ organizationId: organizationWallets.organizationId })
          .from(organizationWallets)
          .where(eq(organizationWallets.provider, "turnkey"))
      ).map((r) => r.organizationId)
    );

    const paraOrgs = paraWallets.filter(
      (w) => w.organizationId !== null && !turnkeyOrgIds.has(w.organizationId)
    );

    const summary: ProvisionSummary = {
      provisioned: 0,
      skipped: 0,
      failed: 0,
    };

    console.log(
      `[provision-turnkey] ${paraOrgs.length} Para-only orgs to process`
    );

    for (const row of paraOrgs) {
      if (row.organizationId === null) {
        summary.skipped += 1;
        continue;
      }
      const orgId = row.organizationId;
      try {
        const orgName = `org-${orgId.slice(0, 8)}`;
        const result = await createTurnkeyWallet(row.email, orgName);

        await db.insert(organizationWallets).values({
          userId: row.userId,
          organizationId: orgId,
          provider: "turnkey",
          email: row.email,
          walletAddress: normalizeAddressForStorage(result.walletAddress),
          turnkeySubOrgId: result.subOrgId,
          turnkeyWalletId: result.walletId,
          turnkeyPrivateKeyId: result.privateKeyId,
          isActive: false,
        });

        summary.provisioned += 1;
        console.log(
          `[provision-turnkey] org=${orgId} turnkey=${result.walletAddress}`
        );
      } catch (error) {
        summary.failed += 1;
        console.error(
          `[provision-turnkey] Failed for org=${orgId}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    console.log(
      `[provision-turnkey] Done. provisioned=${summary.provisioned} skipped=${summary.skipped} failed=${summary.failed}`
    );

    if (summary.provisioned > 0) {
      console.warn(
        "[provision-turnkey] New Turnkey wallets are inactive by default. " +
          "When an admin flips a wallet to Turnkey, workflow writes run through " +
          "the executor -> runner path, which must have TURNKEY_API_PUBLIC_KEY and " +
          "TURNKEY_API_PRIVATE_KEY set. Verify deploy/executor/<env>/values.yaml " +
          "mirrors the keeperhub chart's Turnkey env before flipping any wallet."
      );
    }
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("[provision-turnkey] Fatal:", error);
  process.exit(1);
});
