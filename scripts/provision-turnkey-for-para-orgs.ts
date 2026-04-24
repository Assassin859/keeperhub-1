/**
 * Force-migrate every Para-holding organization onto Turnkey as the active
 * (and only) signer.
 *
 * For each organization that has a Para wallet:
 *   1. If no Turnkey wallet exists, create one via the Turnkey API, reusing
 *      the Para wallet's email. The new row is inserted with is_active = true.
 *   2. If a Turnkey wallet already exists (from the previous dual-wallet
 *      migration phase), flip it to is_active = true.
 *   3. The Para row is marked is_active = false. It is not deleted -- the
 *      user may still hold assets there and the row stays readable until a
 *      follow-up sweep is run.
 *   4. The web3 integration row's display name is re-synced to the Turnkey
 *      wallet's truncated address so workflow nodes render the new signer
 *      without a manual refresh.
 *
 * Runs idempotently: orgs whose Turnkey wallet is already active are skipped.
 *
 * Concurrency: invoked from every pod's init container. A Postgres advisory
 * lock guarantees only one runner does the work; the others exit cleanly.
 *
 * Usage:
 *   npx tsx scripts/provision-turnkey-for-para-orgs.ts
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  normalizeAddressForStorage,
  truncateAddress,
} from "../lib/address-utils";
import * as schema from "../lib/db/schema";
import { createTurnkeyWallet } from "../lib/turnkey/turnkey-operations";

// Stable key for pg_try_advisory_lock. Any constant unique to this task works;
// keep it out of the range used by other advisory locks in the project.
const ADVISORY_LOCK_KEY = 923_102_301 as const;

type MigrationSummary = {
  migrated: number;
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

    const { integrations, organizationWallets } = schema;

    const paraRows = await db
      .select({
        id: organizationWallets.id,
        userId: organizationWallets.userId,
        organizationId: organizationWallets.organizationId,
        email: organizationWallets.email,
        isActive: organizationWallets.isActive,
      })
      .from(organizationWallets)
      .where(eq(organizationWallets.provider, "para"));

    const existingTurnkeyRows = await db
      .select({
        id: organizationWallets.id,
        organizationId: organizationWallets.organizationId,
        walletAddress: organizationWallets.walletAddress,
        isActive: organizationWallets.isActive,
      })
      .from(organizationWallets)
      .where(eq(organizationWallets.provider, "turnkey"));

    const turnkeyByOrg = new Map(
      existingTurnkeyRows
        .filter((r) => r.organizationId !== null)
        .map((r) => [r.organizationId as string, r])
    );

    const summary: MigrationSummary = {
      migrated: 0,
      skipped: 0,
      failed: 0,
    };

    console.log(`[provision-turnkey] ${paraRows.length} Para orgs to process`);

    for (const paraRow of paraRows) {
      if (paraRow.organizationId === null) {
        summary.skipped += 1;
        continue;
      }
      const orgId = paraRow.organizationId;
      const existingTurnkey = turnkeyByOrg.get(orgId);

      // Already fully migrated: Turnkey active, Para inactive.
      if (
        existingTurnkey &&
        existingTurnkey.isActive &&
        !paraRow.isActive
      ) {
        summary.skipped += 1;
        continue;
      }

      try {
        let turnkeyWalletAddress: string;

        if (existingTurnkey) {
          turnkeyWalletAddress = existingTurnkey.walletAddress;
          await db.transaction(async (tx) => {
            await tx
              .update(organizationWallets)
              .set({ isActive: false })
              .where(eq(organizationWallets.id, paraRow.id));
            await tx
              .update(organizationWallets)
              .set({ isActive: true })
              .where(eq(organizationWallets.id, existingTurnkey.id));
            await tx
              .update(integrations)
              .set({ name: truncateAddress(turnkeyWalletAddress) })
              .where(
                and(
                  eq(integrations.organizationId, orgId),
                  eq(integrations.type, "web3")
                )
              );
          });
        } else {
          const orgName = `org-${orgId.slice(0, 8)}`;
          const result = await createTurnkeyWallet(paraRow.email, orgName);
          turnkeyWalletAddress = normalizeAddressForStorage(
            result.walletAddress
          );

          await db.transaction(async (tx) => {
            await tx
              .update(organizationWallets)
              .set({ isActive: false })
              .where(eq(organizationWallets.id, paraRow.id));
            await tx.insert(organizationWallets).values({
              userId: paraRow.userId,
              organizationId: orgId,
              provider: "turnkey",
              email: paraRow.email,
              walletAddress: turnkeyWalletAddress,
              turnkeySubOrgId: result.subOrgId,
              turnkeyWalletId: result.walletId,
              turnkeyPrivateKeyId: result.privateKeyId,
              isActive: true,
            });
            await tx
              .update(integrations)
              .set({ name: truncateAddress(turnkeyWalletAddress) })
              .where(
                and(
                  eq(integrations.organizationId, orgId),
                  eq(integrations.type, "web3")
                )
              );
          });
        }

        summary.migrated += 1;
        console.log(
          `[provision-turnkey] org=${orgId} turnkey=${turnkeyWalletAddress} active=true`
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
      `[provision-turnkey] Done. migrated=${summary.migrated} skipped=${summary.skipped} failed=${summary.failed}`
    );
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("[provision-turnkey] Fatal:", error);
  process.exit(1);
});
