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
};

type ReserveResult =
  | { allowed: true; executionId: string }
  | { allowed: false; reason: string };

/**
 * Atomically check the spending cap and create the execution record.
 *
 * Uses SELECT FOR UPDATE on the cap row to serialize concurrent requests
 * for the same organization. The execution record is inserted inside the
 * same transaction so no gap exists between the cap check and the record
 * that represents in-flight spend.
 *
 * The SUM includes all non-failed executions (pending, running, completed)
 * so that serialized-but-not-yet-completed requests are visible to
 * subsequent callers once their gas totals are recorded.
 *
 * Residual race window: pending/running records have null gasUsedWei so
 * they contribute 0 to the SUM. Two sequential requests can both pass the
 * cap check while the first is still executing. Full elimination would
 * require estimating gas at reservation time (not available pre-execution)
 * or holding the lock through execution (unacceptable for long-running txs).
 * At typical org concurrency this is acceptable.
 */
export async function checkAndReserveExecution(
  params: ReserveExecutionParams
): Promise<ReserveResult> {
  return await db.transaction(async (tx) => {
    const caps = await tx
      .select({ dailyCapWei: organizationSpendCaps.dailyCapWei })
      .from(organizationSpendCaps)
      .where(eq(organizationSpendCaps.organizationId, params.organizationId))
      .for("update")
      .limit(1);

    const cap = caps[0];
    const id = generateId();

    if (!cap) {
      await tx.insert(directExecutions).values({
        id,
        organizationId: params.organizationId,
        apiKeyId: params.apiKeyId,
        type: params.type,
        network: params.network ?? null,
        input: params.input,
        status: "pending",
      });
      return { allowed: true, executionId: id } as const;
    }

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const result = await tx
      .select({
        totalWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
      })
      .from(directExecutions)
      .where(
        and(
          eq(directExecutions.organizationId, params.organizationId),
          ne(directExecutions.status, "failed"),
          gte(directExecutions.createdAt, todayStart)
        )
      )
      .then((rows) => rows[0]);

    const totalWei = BigInt(result?.totalWei ?? "0");
    const dailyCap = BigInt(cap.dailyCapWei);

    if (totalWei >= dailyCap) {
      return { allowed: false, reason: "Daily spending cap exceeded" } as const;
    }

    await tx.insert(directExecutions).values({
      id,
      organizationId: params.organizationId,
      apiKeyId: params.apiKeyId,
      type: params.type,
      network: params.network ?? null,
      input: params.input,
      status: "pending",
    });

    return { allowed: true, executionId: id } as const;
  });
}
