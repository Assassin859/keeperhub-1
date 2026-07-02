import "server-only";

import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { directExecutions, organizationSpendCaps } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

export type SpendCapResult =
  | { allowed: true }
  | { allowed: false; reason: string };

type ReserveExecutionParams = {
  organizationId: string;
  apiKeyId: string;
  type: string;
  network?: string;
  // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
  input: any;
  // Native notional value (wei) this execution moves. "0" for token-only or
  // no-value calls. Charged against the org's daily value cap at reservation.
  reservedValueWei: string;
};

type ReserveResult =
  | { allowed: true; executionId: string }
  | { allowed: false; reason: string };

/**
 * Atomically check the daily value cap and create the execution record.
 *
 * The cap bounds the native notional VALUE moved per org per day, not gas.
 * `reservedValueWei` (known at request time) is charged against
 * `organizationSpendCaps.dailyValueCapWei` inside a SELECT FOR UPDATE on the
 * cap row, which serializes concurrent requests for the same organization. The
 * execution record is inserted in the same transaction carrying its
 * `valueWei`, so the reserved value is immediately visible to subsequent
 * callers -- closing the TOCTOU that the old gas-based cap had (pending/running
 * rows had null gasUsedWei and contributed 0 to the SUM).
 *
 * The cap is the org's `dailyValueCapWei`, set by org admins/owners. When no
 * cap row exists, or it is null, value spending is unlimited.
 */
export async function checkAndReserveExecution(
  params: ReserveExecutionParams
): Promise<ReserveResult> {
  return await db.transaction(async (tx) => {
    const caps = await tx
      .select({ dailyValueCapWei: organizationSpendCaps.dailyValueCapWei })
      .from(organizationSpendCaps)
      .where(eq(organizationSpendCaps.organizationId, params.organizationId))
      .for("update")
      .limit(1);

    const cap = caps[0];
    const id = generateId();

    const insertReservation = () =>
      tx.insert(directExecutions).values({
        id,
        organizationId: params.organizationId,
        apiKeyId: params.apiKeyId,
        type: params.type,
        network: params.network ?? null,
        input: params.input,
        valueWei: params.reservedValueWei,
        status: "pending",
      });

    // No cap configured (no row, or value cap unset) -> unlimited.
    if (!cap || cap.dailyValueCapWei === null) {
      await insertReservation();
      return { allowed: true, executionId: id } as const;
    }

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const result = await tx
      .select({
        totalWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.valueWei} AS NUMERIC)), 0)::text`,
      })
      .from(directExecutions)
      .where(
        and(
          eq(directExecutions.organizationId, params.organizationId),
          ne(directExecutions.status, "failed"),
          gte(directExecutions.createdAt, todayStart),
          // Exclude stale in-flight reservations: a pending/running row from a
          // crashed pod or a throwing core would otherwise hold its reserved
          // value against the cap for the rest of the UTC day. Completed rows
          // always count; pending/running only within a 15m window (matches the
          // concurrency limiter's stale window). Legitimate in-flight requests
          // settle in seconds, so this never drops a real concurrent reservation.
          sql`(${directExecutions.status} = 'completed' OR ${directExecutions.createdAt} > now() - interval '15 minutes')`
        )
      )
      .then((rows) => rows[0]);

    const totalWei = BigInt(result?.totalWei ?? "0");
    const reservedWei = BigInt(params.reservedValueWei);
    const dailyCap = BigInt(cap.dailyValueCapWei);

    // Pre-charge: deny if this request would push the day's total over the cap.
    if (totalWei + reservedWei > dailyCap) {
      return { allowed: false, reason: "Daily spending cap exceeded" } as const;
    }

    await insertReservation();

    return { allowed: true, executionId: id } as const;
  });
}
