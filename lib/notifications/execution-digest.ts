import "server-only";

import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

export type DigestCadence = "daily" | "weekly";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Daily threshold sits below 24h so a cron that fires at a fixed wall-clock time
// each day still sends when the previous send landed a little later. Weekly is
// pinned to Friday (below), guarded by "not already sent today".
const DAILY_DUE_THRESHOLD_MS = 23 * HOUR_MS;

// Weekly digests go out on Tuesday (14:00 UTC cron) -- mid-week mornings see
// the best email engagement. 2 = Tuesday in getUTCDay().
const WEEKLY_DIGEST_UTC_DAY = 2;

function isSameUtcDate(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Whether a digest of the given cadence is due now. Daily sends roughly once a
 * day; weekly sends only on Fridays (UTC), once per day. The cron runs daily at
 * 17:00 UTC, so weekly digests land Friday 17:00 UTC.
 */
export function isDigestDue(
  cadence: DigestCadence,
  lastSentAt: Date | null,
  now: Date
): boolean {
  if (cadence === "weekly") {
    if (now.getUTCDay() !== WEEKLY_DIGEST_UTC_DAY) {
      return false;
    }
    // Avoid a second send if the cron fires more than once on the same Friday.
    return !(lastSentAt && isSameUtcDate(lastSentAt, now));
  }
  if (!lastSentAt) {
    return true;
  }
  return now.getTime() - lastSentAt.getTime() >= DAILY_DUE_THRESHOLD_MS;
}

/** The time window (start) a digest of the given cadence should summarize. */
export function digestWindowStart(cadence: DigestCadence, now: Date): Date {
  const span = cadence === "daily" ? DAY_MS : 7 * DAY_MS;
  return new Date(now.getTime() - span);
}

export type FailingWorkflow = {
  workflowId: string;
  name: string;
  failures: number;
  lastError: string | null;
};

export type MostExecutedWorkflow = {
  workflowId: string;
  name: string;
  runs: number;
};

export type OrgExecutionDigest = {
  total: number;
  success: number;
  error: number;
  // On-chain activity over the window.
  transactionCount: number;
  gasUsedWei: string;
  topFailing: FailingWorkflow[];
  mostExecuted: MostExecutedWorkflow[];
};

const TOP_FAILING_LIMIT = 5;
const TOP_EXECUTED_LIMIT = 3;

/**
 * Aggregate an org's workflow executions over [since, until): totals plus the
 * workflows with the most failures (and each one's most recent error message).
 */
export async function getOrgExecutionDigest(
  organizationId: string,
  since: Date,
  until: Date
): Promise<OrgExecutionDigest> {
  const windowFilter = and(
    eq(workflows.organizationId, organizationId),
    gte(workflowExecutions.startedAt, since),
    lt(workflowExecutions.startedAt, until)
  );

  const [totalsRow] = await db
    .select({
      total: count(),
      success: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} = 'success' THEN 1 ELSE 0 END)`,
      error: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} = 'error' THEN 1 ELSE 0 END)`,
      transactionCount: sql<number>`COALESCE(SUM(CASE WHEN jsonb_typeof(${workflowExecutions.transactionHashes}) = 'array' THEN jsonb_array_length(${workflowExecutions.transactionHashes}) ELSE 0 END), 0)`,
      gasUsedWei: sql<string>`COALESCE(SUM(${workflowExecutions.gasUsedWei}), 0)`,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(windowFilter);

  const mostExecutedRows = await db
    .select({
      workflowId: workflows.id,
      name: workflows.name,
      runs: count(),
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(windowFilter)
    .groupBy(workflows.id, workflows.name)
    .orderBy(desc(count()))
    .limit(TOP_EXECUTED_LIMIT);

  const errorFilter = and(windowFilter, eq(workflowExecutions.status, "error"));

  const failingRows = await db
    .select({
      workflowId: workflows.id,
      name: workflows.name,
      failures: count(),
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(errorFilter)
    .groupBy(workflows.id, workflows.name)
    .orderBy(desc(count()))
    .limit(TOP_FAILING_LIMIT);

  // Latest error message per failing workflow, in one pass over the window.
  const latestErrorRows = await db
    .selectDistinctOn([workflowExecutions.workflowId], {
      workflowId: workflowExecutions.workflowId,
      error: workflowExecutions.error,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(errorFilter)
    .orderBy(workflowExecutions.workflowId, desc(workflowExecutions.startedAt));

  const lastErrorByWorkflow = new Map<string, string | null>();
  for (const row of latestErrorRows) {
    lastErrorByWorkflow.set(row.workflowId, row.error ?? null);
  }

  return {
    total: Number(totalsRow?.total) || 0,
    success: Number(totalsRow?.success) || 0,
    error: Number(totalsRow?.error) || 0,
    transactionCount: Number(totalsRow?.transactionCount) || 0,
    gasUsedWei: totalsRow?.gasUsedWei ?? "0",
    topFailing: failingRows.map((row) => ({
      workflowId: row.workflowId,
      name: row.name,
      failures: Number(row.failures) || 0,
      lastError: lastErrorByWorkflow.get(row.workflowId) ?? null,
    })),
    mostExecuted: mostExecutedRows.map((row) => ({
      workflowId: row.workflowId,
      name: row.name,
      runs: Number(row.runs) || 0,
    })),
  };
}
