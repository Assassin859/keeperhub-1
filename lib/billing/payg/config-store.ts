import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { type PaygConfig, paygConfig } from "@/lib/db/schema-extensions";

/** The org's PAYG config row (spend caps + enable anchor), or null. */
export async function getPaygConfig(
  organizationId: string
): Promise<PaygConfig | null> {
  const rows = await db
    .select()
    .from(paygConfig)
    .where(eq(paygConfig.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create or update the org's PAYG config. `started_at` (the billing-period
 * anchor) is set once on insert and preserved on updates, so editing caps does
 * not reset the period. A fresh anchor comes from disabling (which deletes the
 * row) and re-enabling.
 */
export async function upsertPaygConfig(params: {
  organizationId: string;
  dailyCapRaw: string;
  periodCapRaw: string;
  chainId: number;
}): Promise<void> {
  await db
    .insert(paygConfig)
    .values({
      organizationId: params.organizationId,
      dailyCapRaw: params.dailyCapRaw,
      periodCapRaw: params.periodCapRaw,
      chainId: params.chainId,
    })
    .onConflictDoUpdate({
      target: paygConfig.organizationId,
      set: {
        dailyCapRaw: params.dailyCapRaw,
        periodCapRaw: params.periodCapRaw,
        chainId: params.chainId,
        updatedAt: new Date(),
      },
    });
}

/** Remove the org's PAYG config (on disable), so a later re-enable re-anchors. */
export async function deletePaygConfig(organizationId: string): Promise<void> {
  await db
    .delete(paygConfig)
    .where(eq(paygConfig.organizationId, organizationId));
}
