import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { type NewPaygPayment, paygPayments } from "@/lib/db/schema-extensions";
import { PAYG_PAYMENT_STATUS } from "./constants";

/** Record a settled per-execution payment. Idempotent on (org, execution_id). */
export async function recordPaygPayment(
  payment: NewPaygPayment
): Promise<void> {
  await db.insert(paygPayments).values(payment).onConflictDoNothing();
}

/**
 * The already-recorded payment for one execution, or null. Used to make
 * charging idempotent: a redelivered run must not settle a second on-chain
 * transfer for an execution that was already paid.
 */
export async function findPaygPayment(
  organizationId: string,
  executionId: string
): Promise<{ txHash: string | null; amountRaw: string } | null> {
  const rows = await db
    .select({ txHash: paygPayments.txHash, amountRaw: paygPayments.amountRaw })
    .from(paygPayments)
    .where(
      and(
        eq(paygPayments.organizationId, organizationId),
        eq(paygPayments.executionId, executionId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** SUM of settled USDC (raw) charged in [since, until) for an org. */
export async function getPaygSpentRaw(
  organizationId: string,
  since: Date,
  until?: Date
): Promise<bigint> {
  const upperBound = until
    ? sql`AND created_at < ${until.toISOString()}`
    : sql``;
  const rows = await db.execute<{ spent: string }>(sql`
    SELECT COALESCE(SUM(amount_raw::numeric), 0)::text AS spent
    FROM payg_payments
    WHERE organization_id = ${organizationId}
      AND status = ${PAYG_PAYMENT_STATUS.settled}
      AND created_at >= ${since.toISOString()}
      ${upperBound}
  `);
  return BigInt(rows[0]?.spent ?? "0");
}

/** Most recent settled payments for an org, newest first -- for the history UI. */
export async function listPaygPayments(
  organizationId: string,
  limit = 20
): Promise<
  {
    executionId: string;
    amountRaw: string;
    txHash: string | null;
    chainId: number;
    createdAt: Date;
  }[]
> {
  return await db
    .select({
      executionId: paygPayments.executionId,
      amountRaw: paygPayments.amountRaw,
      txHash: paygPayments.txHash,
      chainId: paygPayments.chainId,
      createdAt: paygPayments.createdAt,
    })
    .from(paygPayments)
    .where(eq(paygPayments.organizationId, organizationId))
    .orderBy(desc(paygPayments.createdAt))
    .limit(limit);
}

/** Executions charged and total USDC (raw) in [since, until) -- for reporting. */
export async function getPaygUsage(
  organizationId: string,
  since: Date,
  until?: Date
): Promise<{ executions: number; spentRaw: bigint }> {
  const upperBound = until
    ? sql`AND created_at < ${until.toISOString()}`
    : sql``;
  const rows = await db.execute<{ executions: number; spent: string }>(sql`
    SELECT COUNT(*)::int AS executions,
           COALESCE(SUM(amount_raw::numeric), 0)::text AS spent
    FROM payg_payments
    WHERE organization_id = ${organizationId}
      AND status = ${PAYG_PAYMENT_STATUS.settled}
      AND created_at >= ${since.toISOString()}
      ${upperBound}
  `);
  return {
    executions: rows[0]?.executions ?? 0,
    spentRaw: BigInt(rows[0]?.spent ?? "0"),
  };
}
