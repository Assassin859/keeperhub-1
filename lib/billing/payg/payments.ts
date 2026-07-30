import "server-only";

import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { type NewPaygPayment, paygPayments } from "@/lib/db/schema-extensions";
import { PAYG_PAYMENT_STATUS } from "./constants";

export type PaygPaymentRow = {
  executionId: string;
  amountRaw: string;
  txHash: string | null;
  chainId: number;
  createdAt: Date;
  workflowId: string | null;
  workflowName: string | null;
};

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

/**
 * One page of an org's PAYG charges, newest first, joined to the workflow
 * execution that triggered each charge. workflowId/workflowName are null when
 * the charge's execution id is not a workflow run (direct-API charges). Returns
 * the slice plus the total row count for server-side pagination.
 */
export async function listPaygPaymentsPage(
  organizationId: string,
  opts: { limit: number; offset: number; search?: string }
): Promise<{ items: PaygPaymentRow[]; total: number }> {
  const term = opts.search?.trim();
  const like = term ? `%${term}%` : null;
  // Free-text search across the charge (execution id, tx hash) and its workflow
  // (id, name). Case-insensitive substring match.
  const searchFilter = like
    ? or(
        ilike(paygPayments.executionId, like),
        ilike(paygPayments.txHash, like),
        ilike(workflowExecutions.workflowId, like),
        ilike(workflows.name, like)
      )
    : undefined;
  const where = and(
    eq(paygPayments.organizationId, organizationId),
    searchFilter
  );

  // The count only needs the workflow joins when the search filters on them;
  // without a search it stays an index-only scan on (organization_id, created_at).
  const countQuery = like
    ? db
        .select({ total: count() })
        .from(paygPayments)
        .leftJoin(
          workflowExecutions,
          eq(workflowExecutions.id, paygPayments.executionId)
        )
        .leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
        .where(where)
    : db.select({ total: count() }).from(paygPayments).where(where);

  const [items, totals] = await Promise.all([
    db
      .select({
        executionId: paygPayments.executionId,
        amountRaw: paygPayments.amountRaw,
        txHash: paygPayments.txHash,
        chainId: paygPayments.chainId,
        createdAt: paygPayments.createdAt,
        workflowId: workflowExecutions.workflowId,
        workflowName: workflows.name,
      })
      .from(paygPayments)
      .leftJoin(
        workflowExecutions,
        eq(workflowExecutions.id, paygPayments.executionId)
      )
      .leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
      .where(where)
      .orderBy(desc(paygPayments.createdAt))
      .limit(opts.limit)
      .offset(opts.offset),
    countQuery,
  ]);
  return { items, total: totals[0]?.total ?? 0 };
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
