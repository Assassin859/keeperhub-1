import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { executionDebt, organizationSubscriptions } from "@/lib/db/schema";
import {
  countMonthlyExecutionsForDisplay,
  effectiveExecutionLimit,
  startOfCurrentMonthUtc,
} from "./execution-limit-core";
import { isBillingEnabled } from "./feature-flag";
import {
  getPlanDisplayName,
  getPlanLimits,
  PAYG_PLAN_NAME,
  PLANS,
  type PlanLimits,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "./plans";
import { getOrgSubscription } from "./plans-server";

/**
 * The single backend signal behind both the quota warning email and the
 * in-app quota banner. Keeping one module compute it is what stops the two
 * from drifting: the cron reads it in bulk for every active org, the banner
 * endpoint reads it for one org, and both get the same percentage.
 *
 * The window is the UTC calendar month, matching admission
 * (execution-limit-core.startOfCurrentMonthUtc) rather than the Stripe billing
 * cycle, so an org is warned against the limit that will actually refuse it.
 */

/** Evaluated high to low; the first match is the threshold an org has reached. */
export const QUOTA_THRESHOLDS = [100, 80] as const;

export type QuotaThreshold = (typeof QUOTA_THRESHOLDS)[number];

/** Below this, an org is not a candidate and never reaches a per-org query. */
export const LOWEST_QUOTA_THRESHOLD: QuotaThreshold =
  QUOTA_THRESHOLDS.at(-1) ?? 80;

export function crossedQuotaThreshold(
  usagePercent: number
): QuotaThreshold | null {
  for (const threshold of QUOTA_THRESHOLDS) {
    if (usagePercent >= threshold) {
      return threshold;
    }
  }
  return null;
}

export type QuotaStatus = {
  organizationId: string;
  plan: PlanName;
  planLabel: string;
  /** Billable executions counted in the current UTC month. */
  used: number;
  /** Included limit reduced by active debt, the number that actually gates. */
  limit: number;
  /** Plan/tier included limit before debt is applied. */
  includedLimit: number;
  debtExecutions: number;
  /** Floored so a displayed 80% and a fired 80% notification always agree. */
  usagePercent: number;
  threshold: QuotaThreshold | null;
  periodStart: Date;
  /** Exclusive: when the count resets to zero. */
  periodEnd: Date;
  /** Org can keep running past the limit by paying per execution. */
  paygEligible: boolean;
  /** Dollars per 1,000 executions past the limit, or null when not billed. */
  overageRatePerThousand: number | null;
};

function startOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Turn a counted usage figure into a quota status. No DB access, so both the
 * bulk cron path and the single-org path share the arithmetic.
 *
 * Returns null for unlimited plans, which have no percentage to report.
 */
export function buildQuotaStatus(params: {
  organizationId: string;
  plan: PlanName;
  tier: TierKey | null;
  planOverrides: Partial<PlanLimits> | null | undefined;
  used: number;
  debtExecutions: number;
  now?: Date;
}): QuotaStatus | null {
  const now = params.now ?? new Date();
  const limits = getPlanLimits(params.plan, params.tier, params.planOverrides);
  const includedLimit = limits.maxExecutionsPerMonth;

  if (includedLimit < 0) {
    return null;
  }

  const limit = effectiveExecutionLimit(includedLimit, params.debtExecutions);
  const usagePercent =
    limit > 0 ? Math.floor((params.used / limit) * 100) : 100;
  const planDef = PLANS[params.plan];

  return {
    organizationId: params.organizationId,
    plan: params.plan,
    planLabel: getPlanDisplayName(params.plan),
    used: params.used,
    limit,
    includedLimit,
    debtExecutions: params.debtExecutions,
    usagePercent,
    threshold: crossedQuotaThreshold(usagePercent),
    periodStart: startOfCurrentMonthUtc(now),
    periodEnd: startOfNextMonthUtc(now),
    paygEligible: params.plan === PAYG_PLAN_NAME && isBillingEnabled(),
    overageRatePerThousand: planDef.overage.enabled
      ? planDef.overage.ratePerThousand
      : null,
  };
}

/**
 * The quota status for one org. Used by the banner endpoint.
 *
 * Reads the display count, which shares the guard's TTL cache but never takes
 * its near-limit re-read: this runs on every dashboard load, and the orgs that
 * would trigger that re-read are exactly the ones this banner keeps in front
 * of. A banner being up to one TTL late costs nothing.
 */
export async function getOrgQuotaStatus(
  organizationId: string,
  now: Date = new Date()
): Promise<QuotaStatus | null> {
  const sub = await getOrgSubscription(organizationId);
  const plan = parsePlanName(sub?.plan);
  const tier = parseTierKey(sub?.tier);

  if (getPlanLimits(plan, tier, sub?.planOverrides).maxExecutionsPerMonth < 0) {
    return null;
  }

  const periodStart = startOfCurrentMonthUtc(now);
  const [used, debtExecutions] = await Promise.all([
    countMonthlyExecutionsForDisplay(db, organizationId, periodStart),
    getActiveDebtForOrg(organizationId),
  ]);

  return buildQuotaStatus({
    organizationId,
    plan,
    tier,
    planOverrides: sub?.planOverrides,
    used,
    debtExecutions,
    now,
  });
}

async function getActiveDebtForOrg(organizationId: string): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${executionDebt.debtExecutions}), 0)::int`,
    })
    .from(executionDebt)
    .where(
      and(
        eq(executionDebt.organizationId, organizationId),
        eq(executionDebt.status, "active")
      )
    );
  return rows[0]?.total ?? 0;
}

type OrgUsageRow = { organizationId: string; used: number };

/**
 * Billable executions this month for every org that ran at least one, in a
 * single aggregate. Orgs with no activity cannot have crossed a threshold, so
 * they never enter the scan.
 */
async function countMonthlyExecutionsByOrg(
  periodStart: Date
): Promise<OrgUsageRow[]> {
  const since = periodStart.toISOString();
  const rows = await db.execute<{ organization_id: string; used: number }>(
    sql`SELECT org_id AS organization_id, SUM(subtotal)::int AS used
          FROM (
            SELECT w.organization_id AS org_id, COUNT(*)::int AS subtotal
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE we.started_at >= ${since}
               AND we.billable = TRUE
             GROUP BY w.organization_id
            UNION ALL
            SELECT de.organization_id AS org_id, COUNT(*)::int AS subtotal
              FROM direct_executions de
             WHERE de.created_at >= ${since}
             GROUP BY de.organization_id
          ) t
         GROUP BY org_id`
  );

  return rows.map((row) => ({
    organizationId: row.organization_id,
    used: row.used,
  }));
}

async function getActiveDebtByOrg(
  organizationIds: string[]
): Promise<Map<string, number>> {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      organizationId: executionDebt.organizationId,
      total: sql<number>`COALESCE(SUM(${executionDebt.debtExecutions}), 0)::int`,
    })
    .from(executionDebt)
    .where(
      and(
        inArray(executionDebt.organizationId, organizationIds),
        eq(executionDebt.status, "active")
      )
    )
    .groupBy(executionDebt.organizationId);
  return new Map(rows.map((row) => [row.organizationId, row.total]));
}

type SubscriptionRow = {
  plan: PlanName;
  tier: TierKey | null;
  planOverrides: Partial<PlanLimits> | null;
};

async function getSubscriptionsByOrg(
  organizationIds: string[]
): Promise<Map<string, SubscriptionRow>> {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      organizationId: organizationSubscriptions.organizationId,
      plan: organizationSubscriptions.plan,
      tier: organizationSubscriptions.tier,
      planOverrides: organizationSubscriptions.planOverrides,
    })
    .from(organizationSubscriptions)
    .where(inArray(organizationSubscriptions.organizationId, organizationIds));

  return new Map(
    rows.map((row) => [
      row.organizationId,
      {
        plan: parsePlanName(row.plan),
        tier: parseTierKey(row.tier),
        planOverrides: row.planOverrides ?? null,
      },
    ])
  );
}

/**
 * Every org that has reached at least the lowest threshold this month.
 *
 * Three queries regardless of org count: one usage aggregate, one subscription
 * fetch, one debt fetch. An org with no subscription row is on the free plan
 * defaults, which is how a never-subscribed org still gets warned.
 */
export async function findOrgsAtQuotaThreshold(
  now: Date = new Date()
): Promise<QuotaStatus[]> {
  const periodStart = startOfCurrentMonthUtc(now);
  const usage = await countMonthlyExecutionsByOrg(periodStart);
  if (usage.length === 0) {
    return [];
  }

  const organizationIds = usage.map((row) => row.organizationId);
  const [subscriptions, debt] = await Promise.all([
    getSubscriptionsByOrg(organizationIds),
    getActiveDebtByOrg(organizationIds),
  ]);

  const statuses: QuotaStatus[] = [];
  for (const row of usage) {
    const sub = subscriptions.get(row.organizationId);
    const status = buildQuotaStatus({
      organizationId: row.organizationId,
      plan: sub?.plan ?? "free",
      tier: sub?.tier ?? null,
      planOverrides: sub?.planOverrides,
      used: row.used,
      debtExecutions: debt.get(row.organizationId) ?? 0,
      now,
    });
    if (status && status.threshold !== null) {
      statuses.push(status);
    }
  }
  return statuses;
}
