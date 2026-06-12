import "server-only";

import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logInputField, logOutputField } from "@/lib/db/execution-log-fields";
import {
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import {
  directExecutions,
  organizationSpendCaps,
} from "@/lib/db/schema-extensions";
import { analyticsCacheKey, cachedAnalytics } from "./cache";
import {
  getBucketInterval,
  getPreviousPeriodStart,
  getTimeRangeStart,
} from "./time-range";
import type {
  AnalyticsSummary,
  NetworkBreakdown,
  NormalizedStatus,
  RunSource,
  StepLog,
  TimeRange,
  TimeSeriesBucket,
  UnifiedRun,
} from "./types";

/**
 * Normalize workflow execution status to a unified status.
 * workflow_executions uses: pending | running | success | error | cancelled
 * direct_executions uses: pending | running | completed | failed
 * We normalize to: pending | running | success | error
 */
export function normalizeStatus(
  status: string,
  source: RunSource
): NormalizedStatus {
  if (source === "direct") {
    if (status === "completed") {
      return "success";
    }
    if (status === "failed") {
      return "error";
    }
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  // Phantom rows are runs that were enqueued but never picked up; they have no
  // user-facing status of their own and surface as pending everywhere in the UI.
  if (status === "phantom") {
    return "pending";
  }
  return status as NormalizedStatus;
}

/**
 * Map a normalized status to the direct_executions DB status values.
 */
function directDbStatuses(status: NormalizedStatus): string[] {
  if (status === "success") {
    return ["completed"];
  }
  if (status === "error") {
    return ["failed"];
  }
  return [status];
}

/**
 * Map a normalized status to the workflow_executions DB status values.
 * Phantom maps to pending for display, so the pending filter must also match
 * phantom rows to keep the badge and filter consistent.
 */
export function workflowDbStatuses(status: NormalizedStatus): string[] {
  if (status === "pending") {
    return ["pending", "phantom"];
  }
  return [status];
}

/**
 * Parse a bucket row into a TimeSeriesBucket.
 */
function parseBucketRow(row: {
  bucket: string;
  success: string;
  error: string;
  cancelled: string;
  pending: string;
  running: string;
}): TimeSeriesBucket {
  return {
    timestamp: new Date(row.bucket).toISOString(),
    success: Number(row.success) || 0,
    error: Number(row.error) || 0,
    cancelled: Number(row.cancelled) || 0,
    pending: Number(row.pending) || 0,
    running: Number(row.running) || 0,
  };
}

/**
 * Merge a parsed bucket into an existing map, summing values.
 */
function addBucketToMap(
  map: Map<string, TimeSeriesBucket>,
  bucket: TimeSeriesBucket
): void {
  const existing = map.get(bucket.timestamp);
  if (existing) {
    existing.success += bucket.success;
    existing.error += bucket.error;
    existing.cancelled += bucket.cancelled;
    existing.pending += bucket.pending;
    existing.running += bucket.running;
  } else {
    map.set(bucket.timestamp, { ...bucket });
  }
}

/**
 * Only named ranges are cached. A custom range carries caller-supplied
 * start/end strings that are effectively single-use and unbounded, so keying
 * the per-process cache on them would grow the Map without limit for no
 * hit-rate benefit (and is a cheap memory-pressure vector). Recompute those
 * directly; the named ranges are what the dashboard and SSE push hammer.
 */
export function isCacheableRange(
  range: TimeRange,
  customStart?: string,
  customEnd?: string
): boolean {
  return (
    range !== "custom" && customStart === undefined && customEnd === undefined
  );
}

/**
 * Fetch KPI summary for the analytics dashboard. Named ranges are cached per
 * (org, range, project) - both the GET route and the SSE summary push go
 * through here, so the cache covers the dominant recompute path. Custom ranges
 * bypass the cache (see isCacheableRange).
 */
export function getAnalyticsSummary(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  projectId?: string
): Promise<AnalyticsSummary> {
  const compute = () =>
    computeAnalyticsSummary(
      organizationId,
      range,
      customStart,
      customEnd,
      projectId
    );
  if (!isCacheableRange(range, customStart, customEnd)) {
    return compute();
  }
  return cachedAnalytics(
    analyticsCacheKey("summary", [organizationId, range, projectId]),
    compute
  );
}

async function computeAnalyticsSummary(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  projectId?: string
): Promise<AnalyticsSummary> {
  const rangeStart = getTimeRangeStart(range, customStart);
  const rangeEnd = customEnd ? new Date(customEnd) : new Date();

  const skipDirect = Boolean(projectId);

  const [
    workflowStats,
    directStats,
    activeWorkflows,
    activeDirects,
    previousPeriod,
    workflowGasWei,
  ] = await Promise.all([
    getWorkflowCounts(organizationId, rangeStart, rangeEnd, projectId),
    skipDirect
      ? {
          total: 0,
          success: 0,
          error: 0,
          durationSum: 0,
          durationCount: 0,
          totalGasWei: "0",
        }
      : getDirectCounts(organizationId, rangeStart, rangeEnd),
    getActiveWorkflowCount(organizationId, projectId),
    skipDirect ? 0 : getActiveDirectCount(organizationId),
    getPreviousPeriodSummary(
      organizationId,
      range,
      customStart,
      customEnd,
      projectId
    ),
    getWorkflowGasTotal(organizationId, rangeStart, rangeEnd, projectId),
  ]);

  const totalRuns = workflowStats.total + directStats.total;
  const successCount = workflowStats.success + directStats.success;
  const errorCount = workflowStats.error + directStats.error;
  const cancelledCount = workflowStats.cancelled;
  const successRate = totalRuns > 0 ? successCount / totalRuns : 0;

  const avgDurationMs = computeAvgDuration(
    workflowStats.durationSum + directStats.durationSum,
    workflowStats.durationCount + directStats.durationCount
  );

  const totalGasWei = addBigIntStrings(directStats.totalGasWei, workflowGasWei);

  return {
    totalRuns,
    successCount,
    errorCount,
    cancelledCount,
    successRate,
    avgDurationMs,
    totalGasWei,
    activeRuns: activeWorkflows + activeDirects,
    previousPeriod,
  };
}

async function getWorkflowCounts(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  projectId?: string
): Promise<{
  total: number;
  success: number;
  error: number;
  cancelled: number;
  durationSum: number;
  durationCount: number;
}> {
  const result = await db
    .select({
      total: count(),
      success: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} = 'success' THEN 1 ELSE 0 END)`,
      error: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} = 'error' THEN 1 ELSE 0 END)`,
      cancelled: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} = 'cancelled' THEN 1 ELSE 0 END)`,
      durationSum: sql<number>`COALESCE(SUM(${workflowExecutions.duration}), 0)`,
      durationCount: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} IS NOT NULL THEN 1 ELSE 0 END)`,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        projectId ? eq(workflows.projectId, projectId) : undefined,
        gte(workflowExecutions.startedAt, rangeStart),
        lt(workflowExecutions.startedAt, rangeEnd)
      )
    );

  const row = result[0];
  return {
    total: Number(row?.total) || 0,
    success: Number(row?.success) || 0,
    error: Number(row?.error) || 0,
    cancelled: Number(row?.cancelled) || 0,
    durationSum: Number(row?.durationSum) || 0,
    durationCount: Number(row?.durationCount) || 0,
  };
}

async function getDirectCounts(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date
): Promise<{
  total: number;
  success: number;
  error: number;
  durationSum: number;
  durationCount: number;
  totalGasWei: string;
}> {
  const result = await db
    .select({
      total: count(),
      success: sql<number>`SUM(CASE WHEN ${directExecutions.status} = 'completed' THEN 1 ELSE 0 END)`,
      error: sql<number>`SUM(CASE WHEN ${directExecutions.status} = 'failed' THEN 1 ELSE 0 END)`,
      durationSum: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${directExecutions.completedAt} - ${directExecutions.createdAt})) * 1000), 0)`,
      durationCount: sql<number>`SUM(CASE WHEN ${directExecutions.completedAt} IS NOT NULL THEN 1 ELSE 0 END)`,
      totalGasWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
    })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        gte(directExecutions.createdAt, rangeStart),
        lt(directExecutions.createdAt, rangeEnd)
      )
    );

  const row = result[0];
  return {
    total: Number(row?.total) || 0,
    success: Number(row?.success) || 0,
    error: Number(row?.error) || 0,
    durationSum: Number(row?.durationSum) || 0,
    durationCount: Number(row?.durationCount) || 0,
    totalGasWei: row?.totalGasWei ?? "0",
  };
}

function getActiveWorkflowCount(
  organizationId: string,
  projectId?: string
): Promise<number> {
  return db
    .select({ count: count() })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        projectId ? eq(workflows.projectId, projectId) : undefined,
        sql`${workflowExecutions.status} IN ('pending', 'running')`
      )
    )
    .then((r) => Number(r[0]?.count) || 0);
}

function getActiveDirectCount(organizationId: string): Promise<number> {
  return db
    .select({ count: count() })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        sql`${directExecutions.status} IN ('pending', 'running')`
      )
    )
    .then((r) => Number(r[0]?.count) || 0);
}

async function getPreviousPeriodSummary(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  projectId?: string
): Promise<AnalyticsSummary["previousPeriod"]> {
  const { start, end } = getPreviousPeriodStart(range, customStart, customEnd);
  const skipDirect = Boolean(projectId);

  const [workflowStats, directStats, workflowGasWei] = await Promise.all([
    getWorkflowCounts(organizationId, start, end, projectId),
    skipDirect
      ? {
          total: 0,
          success: 0,
          error: 0,
          durationSum: 0,
          durationCount: 0,
          totalGasWei: "0",
        }
      : getDirectCounts(organizationId, start, end),
    getWorkflowGasTotal(organizationId, start, end, projectId),
  ]);

  return {
    totalRuns: workflowStats.total + directStats.total,
    successCount: workflowStats.success + directStats.success,
    errorCount: workflowStats.error + directStats.error,
    cancelledCount: workflowStats.cancelled,
    avgDurationMs: computeAvgDuration(
      workflowStats.durationSum + directStats.durationSum,
      workflowStats.durationCount + directStats.durationCount
    ),
    totalGasWei: addBigIntStrings(directStats.totalGasWei, workflowGasWei),
  };
}

function computeAvgDuration(sum: number, durationCount: number): number | null {
  if (durationCount === 0) {
    return null;
  }
  return Math.round(sum / durationCount);
}

function addBigIntStrings(a: string, b: string): string {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

async function getWorkflowGasTotal(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  projectId?: string
): Promise<string> {
  // Reads the denormalised run-total `gas_used_wei` written at finalize
  // (lib/workflow/executor/logging.ts) instead of re-summing the per-step logs
  // JSONB. No logs join, no JSONB parse, no TOAST detoast - the org+window slice
  // is aggregated straight off workflow_executions. SUM skips NULL, so runs with
  // no gas need no explicit filter.
  //
  // The window is now `workflow_executions.started_at` (when the run started),
  // not the per-step `started_at`. Since the column is a run-level rollup that
  // is the correct axis, and it matches every other summary metric, which is
  // already keyed to run start. Boundary-straddling runs can reattribute by the
  // gap between run start and a late step; immaterial at dashboard granularity.
  const result = await db
    .select({
      totalGas: sql<string>`COALESCE(SUM(CAST(${workflowExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        projectId ? eq(workflows.projectId, projectId) : undefined,
        gte(workflowExecutions.startedAt, rangeStart),
        lt(workflowExecutions.startedAt, rangeEnd)
      )
    );

  return result[0]?.totalGas ?? "0";
}

/**
 * Fetch time-series bucketed data for charts. Named ranges cached per
 * (org, range, project); custom ranges bypass the cache (see isCacheableRange).
 */
export function getTimeSeries(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  projectId?: string
): Promise<TimeSeriesBucket[]> {
  const compute = () =>
    computeTimeSeries(organizationId, range, customStart, customEnd, projectId);
  if (!isCacheableRange(range, customStart, customEnd)) {
    return compute();
  }
  return cachedAnalytics(
    analyticsCacheKey("time-series", [organizationId, range, projectId]),
    compute
  );
}

async function computeTimeSeries(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  projectId?: string
): Promise<TimeSeriesBucket[]> {
  const rangeStart = getTimeRangeStart(range, customStart);
  const rangeEnd = customEnd ? new Date(customEnd) : new Date();
  const { sqlInterval } = getBucketInterval(range);
  const bucketExpr = bucketSql(sqlInterval);

  const workflowBuckets = await db
    .select({
      bucket: sql<string>`${bucketExpr(workflowExecutions.startedAt)}`,
      success: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} = 'success' THEN 1 ELSE 0 END)`,
      error: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} = 'error' THEN 1 ELSE 0 END)`,
      cancelled: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} = 'cancelled' THEN 1 ELSE 0 END)`,
      pending: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} = 'pending' THEN 1 ELSE 0 END)`,
      running: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} = 'running' THEN 1 ELSE 0 END)`,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        projectId ? eq(workflows.projectId, projectId) : undefined,
        gte(workflowExecutions.startedAt, rangeStart),
        lt(workflowExecutions.startedAt, rangeEnd)
      )
    )
    .groupBy(sql`${bucketExpr(workflowExecutions.startedAt)}`)
    .orderBy(sql`${bucketExpr(workflowExecutions.startedAt)} ASC`);

  if (projectId) {
    return mergeBuckets(workflowBuckets as BucketRow[], []);
  }

  const directBuckets = await db
    .select({
      bucket: sql<string>`${bucketExpr(directExecutions.createdAt)}`,
      success: sql<string>`SUM(CASE WHEN ${directExecutions.status} = 'completed' THEN 1 ELSE 0 END)`,
      error: sql<string>`SUM(CASE WHEN ${directExecutions.status} = 'failed' THEN 1 ELSE 0 END)`,
      cancelled: sql<string>`0`,
      pending: sql<string>`SUM(CASE WHEN ${directExecutions.status} = 'pending' THEN 1 ELSE 0 END)`,
      running: sql<string>`SUM(CASE WHEN ${directExecutions.status} = 'running' THEN 1 ELSE 0 END)`,
    })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        gte(directExecutions.createdAt, rangeStart),
        lt(directExecutions.createdAt, rangeEnd)
      )
    )
    .groupBy(sql`${bucketExpr(directExecutions.createdAt)}`)
    .orderBy(sql`${bucketExpr(directExecutions.createdAt)} ASC`);

  return mergeBuckets(
    workflowBuckets as BucketRow[],
    directBuckets as BucketRow[]
  );
}

/**
 * Build a SQL fragment that truncates a timestamp column to the given bucket interval.
 * Uses date_trunc for standard intervals and integer division for sub-hour buckets.
 */
function bucketSql(
  sqlInterval: string
): (
  col: typeof workflowExecutions.startedAt | typeof directExecutions.createdAt
) => ReturnType<typeof sql> {
  if (sqlInterval === "1 day") {
    return (col) => sql`date_trunc('day', ${col})`;
  }
  if (sqlInterval === "6 hours") {
    return (col) =>
      sql`date_trunc('day', ${col}) + FLOOR(EXTRACT(HOUR FROM ${col}) / 6) * INTERVAL '6 hours'`;
  }
  if (sqlInterval === "5 minutes") {
    return (col) =>
      sql`date_trunc('hour', ${col}) + FLOOR(EXTRACT(MINUTE FROM ${col}) / 5) * 5 * INTERVAL '1 minute'`;
  }
  return (col) => sql`date_trunc('hour', ${col})`;
}

type BucketRow = {
  bucket: string;
  success: string;
  error: string;
  cancelled: string;
  pending: string;
  running: string;
};

function mergeBuckets(
  workflowRows: BucketRow[],
  directRows: BucketRow[]
): TimeSeriesBucket[] {
  const map = new Map<string, TimeSeriesBucket>();

  for (const row of workflowRows) {
    addBucketToMap(map, parseBucketRow(row));
  }

  for (const row of directRows) {
    addBucketToMap(map, parseBucketRow(row));
  }

  return [...map.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
}

/**
 * Fetch gas breakdown by network. Named ranges cached per (org, range,
 * project); custom ranges bypass the cache (see isCacheableRange).
 */
export function getNetworkBreakdown(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  projectId?: string
): Promise<NetworkBreakdown[]> {
  const compute = () =>
    computeNetworkBreakdown(
      organizationId,
      range,
      customStart,
      customEnd,
      projectId
    );
  if (!isCacheableRange(range, customStart, customEnd)) {
    return compute();
  }
  return cachedAnalytics(
    analyticsCacheKey("networks", [organizationId, range, projectId]),
    compute
  );
}

async function computeNetworkBreakdown(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  projectId?: string
): Promise<NetworkBreakdown[]> {
  const rangeStart = getTimeRangeStart(range, customStart);
  const rangeEnd = customEnd ? new Date(customEnd) : new Date();
  const skipDirect = Boolean(projectId);

  const [directResult, workflowResult] = await Promise.all([
    skipDirect
      ? ([] as {
          network: string;
          totalGasWei: string;
          executionCount: number;
          successCount: number;
          errorCount: number;
        }[])
      : db
          .select({
            network: directExecutions.network,
            totalGasWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
            executionCount: count(),
            successCount: sql<number>`SUM(CASE WHEN ${directExecutions.status} = 'completed' THEN 1 ELSE 0 END)`,
            errorCount: sql<number>`SUM(CASE WHEN ${directExecutions.status} = 'failed' THEN 1 ELSE 0 END)`,
          })
          .from(directExecutions)
          .where(
            and(
              eq(directExecutions.organizationId, organizationId),
              gte(directExecutions.createdAt, rangeStart),
              lt(directExecutions.createdAt, rangeEnd)
            )
          )
          .groupBy(directExecutions.network),
    db
      .select({
        network: sql<string>`${logInputField("network")}`,
        totalGasWei: sql<string>`COALESCE(SUM(CAST(${logOutputField("gasUsed")} AS NUMERIC)), 0)::text`,
        executionCount: count(),
        successCount: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.status} = 'success' THEN 1 ELSE 0 END)`,
        errorCount: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.status} = 'error' THEN 1 ELSE 0 END)`,
      })
      .from(workflowExecutionLogs)
      .innerJoin(
        workflowExecutions,
        eq(workflowExecutionLogs.executionId, workflowExecutions.id)
      )
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(
        and(
          eq(workflows.organizationId, organizationId),
          projectId ? eq(workflows.projectId, projectId) : undefined,
          gte(workflowExecutionLogs.startedAt, rangeStart),
          lt(workflowExecutionLogs.startedAt, rangeEnd),
          sql`${logOutputField("gasUsed")} IS NOT NULL`
        )
      )
      .groupBy(sql`${logInputField("network")}`),
  ]);

  const networkMap = new Map<string, NetworkBreakdown>();

  for (const row of directResult) {
    const networkKey = row.network ?? "unknown";
    networkMap.set(networkKey, {
      network: networkKey,
      totalGasWei: row.totalGasWei,
      executionCount: Number(row.executionCount),
      successCount: Number(row.successCount),
      errorCount: Number(row.errorCount),
    });
  }

  for (const row of workflowResult) {
    const { network } = row;
    if (!network) {
      continue;
    }
    const existing = networkMap.get(network);
    if (existing) {
      existing.totalGasWei = addBigIntStrings(
        existing.totalGasWei,
        row.totalGasWei
      );
      existing.executionCount += Number(row.executionCount);
      existing.successCount += Number(row.successCount);
      existing.errorCount += Number(row.errorCount);
    } else {
      networkMap.set(network, {
        network,
        totalGasWei: row.totalGasWei,
        executionCount: Number(row.executionCount),
        successCount: Number(row.successCount),
        errorCount: Number(row.errorCount),
      });
    }
  }

  return [...networkMap.values()].sort((a, b) => {
    const diff = BigInt(b.totalGasWei) - BigInt(a.totalGasWei);
    if (diff > BigInt(0)) {
      return 1;
    }
    if (diff < BigInt(0)) {
      return -1;
    }
    return 0;
  });
}

/**
 * Fetch unified runs with page-based or cursor-based pagination.
 * Merges workflow and direct runs, sorts by time, then applies
 * offset for the requested page. Runs fetch + count in parallel.
 */
export async function getUnifiedRuns(
  organizationId: string,
  range: TimeRange,
  options: {
    cursor?: string;
    page?: number;
    limit?: number;
    status?: NormalizedStatus;
    source?: RunSource;
    customStart?: string;
    customEnd?: string;
    projectId?: string;
  } = {}
): Promise<{
  runs: UnifiedRun[];
  nextCursor: string | null;
  total: number;
  page: number;
  pageSize: number;
}> {
  const {
    cursor,
    page = 1,
    limit = 50,
    status,
    source,
    customStart,
    customEnd,
    projectId,
  } = options;
  const rangeStart = getTimeRangeStart(range, customStart);
  const rangeEnd = customEnd ? new Date(customEnd) : new Date();
  const pageLimit = Math.min(limit, 100);
  const skipDirect = Boolean(projectId) || source === "direct";
  const offset = cursor ? 0 : (page - 1) * pageLimit;

  // Fetch enough rows from each source to fill the requested page after merging.
  // We need offset + pageLimit + 1 rows from each source to correctly paginate
  // the merged, sorted result set.
  const fetchLimit = cursor ? pageLimit + 1 : offset + pageLimit + 1;

  // Fire run fetches and count queries in parallel
  const [workflowRuns, directRuns, total] = await Promise.all([
    source === "direct"
      ? ([] as UnifiedRun[])
      : fetchWorkflowRuns(
          organizationId,
          rangeStart,
          rangeEnd,
          status,
          cursor,
          fetchLimit,
          projectId
        ),
    skipDirect || source === "workflow"
      ? ([] as UnifiedRun[])
      : fetchDirectRuns(
          organizationId,
          rangeStart,
          rangeEnd,
          status,
          cursor,
          fetchLimit
        ),
    getUnifiedRunsTotal(
      organizationId,
      rangeStart,
      rangeEnd,
      status,
      source,
      projectId
    ),
  ]);

  // Merge both sources, sort by time, then apply offset for the requested page
  const allRuns = [...workflowRuns, ...directRuns].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const sliceStart = cursor ? 0 : offset;
  const sliced = allRuns.slice(sliceStart, sliceStart + pageLimit + 1);
  const hasMore = sliced.length > pageLimit;
  const pagedRuns = sliced.slice(0, pageLimit);
  const nextCursor = hasMore ? (pagedRuns.at(-1)?.startedAt ?? null) : null;

  return { runs: pagedRuns, nextCursor, total, page, pageSize: pageLimit };
}

async function fetchWorkflowRuns(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined,
  cursor: string | undefined,
  limit: number,
  projectId?: string
): Promise<UnifiedRun[]> {
  // Scope to org's workflows via subquery so leftJoin still enforces org isolation
  const orgWorkflowIds = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        projectId ? eq(workflows.projectId, projectId) : undefined
      )
    );

  const conditions = [
    sql`${workflowExecutions.workflowId} IN (${orgWorkflowIds})`,
    gte(workflowExecutions.startedAt, rangeStart),
    lt(workflowExecutions.startedAt, rangeEnd),
  ];

  if (status) {
    const dbStatuses = workflowDbStatuses(status);
    conditions.push(
      sql`${workflowExecutions.status} IN (${sql.join(
        dbStatuses.map((s) => sql`${s}`),
        sql`, `
      )})`
    );
  }

  if (cursor) {
    conditions.push(lt(workflowExecutions.startedAt, new Date(cursor)));
  }

  // Restrict the gas/network aggregation to the executions this page will
  // actually return. The outer query selects the page via the same conditions
  // + order + limit, and the leftJoin to log_summary does not change which rows
  // come back - so narrowing the aggregate to those <= limit execution IDs is
  // value-identical. The prior subquery scoped only to org + window, so the
  // JSONB gas extraction ran over the whole slice on every load even though
  // only `limit` rows are returned.
  //
  // The order/limit here must match the outer query exactly, including the
  // secondary `id` key: started_at alone is not unique, so without a stable
  // tiebreaker the two independent ORDER BY ... LIMIT evaluations could select
  // different rows at the boundary and drop a boundary row's gas. `id` is a
  // unique total order, so both queries resolve ties identically.
  const pagedExecutionIds = db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(and(...conditions))
    .orderBy(desc(workflowExecutions.startedAt), desc(workflowExecutions.id))
    .limit(limit);

  // KEEP-470: gas + network still come from per-log aggregation (no top-level
  // column exists for them yet). Transaction hashes now come from the
  // workflow_executions.transaction_hashes column directly - it carries the
  // full ordered list (one entry per tx-producing step, including For-Each
  // iterations), already populated atomically with the status='success' flip
  // by lib/workflow/executor/logging.ts. The legacy MIN aggregate from
  // workflow_execution_logs was a workaround that picked an arbitrary single
  // hash per run; multi-tx workflows (approve+swap, fan-outs) silently lost
  // every hash but one.
  const logSummary = db
    .select({
      executionId: workflowExecutionLogs.executionId,
      gasUsedWei:
        sql<string>`COALESCE(SUM(CAST(${logOutputField("gasUsed")} AS NUMERIC)), 0)::text`.as(
          "gasUsedWei"
        ),
      network: sql<string | null>`MIN(
        CASE WHEN ${logOutputField("gasUsed")} IS NOT NULL
        THEN ${logInputField("network")}
        END
      )`.as("network"),
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        sql`${workflowExecutionLogs.executionId} IN (${pagedExecutionIds})`,
        sql`${logOutputField("gasUsed")} IS NOT NULL`
      )
    )
    .groupBy(workflowExecutionLogs.executionId)
    .as("log_summary");

  const result = await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      startedAt: workflowExecutions.startedAt,
      completedAt: workflowExecutions.completedAt,
      duration: workflowExecutions.duration,
      workflowId: workflowExecutions.workflowId,
      workflowName: workflows.name,
      totalSteps: workflowExecutions.totalSteps,
      completedSteps: workflowExecutions.completedSteps,
      gasUsedWei: logSummary.gasUsedWei,
      network: logSummary.network,
      transactionHashes: workflowExecutions.transactionHashes,
    })
    .from(workflowExecutions)
    .leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .leftJoin(logSummary, eq(workflowExecutions.id, logSummary.executionId))
    .where(and(...conditions))
    // Secondary `id` key must match pagedExecutionIds above so the page and the
    // gas subquery resolve started_at ties to the same rows.
    .orderBy(desc(workflowExecutions.startedAt), desc(workflowExecutions.id))
    .limit(limit);

  return result.map((row) => ({
    id: row.id,
    source: "workflow" as const,
    status: normalizeStatus(row.status, "workflow"),
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.duration ? Number(row.duration) : null,
    workflowId: row.workflowId,
    workflowName: row.workflowName ?? "(Deleted)",
    directType: null,
    network: row.network ?? null,
    transactionHashes: row.transactionHashes,
    gasUsedWei:
      row.gasUsedWei && row.gasUsedWei !== "0" ? row.gasUsedWei : null,
    totalSteps: row.totalSteps ? Number(row.totalSteps) : null,
    completedSteps: row.completedSteps ? Number(row.completedSteps) : null,
  }));
}

async function fetchDirectRuns(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined,
  cursor: string | undefined,
  limit: number
): Promise<UnifiedRun[]> {
  const conditions = [
    eq(directExecutions.organizationId, organizationId),
    gte(directExecutions.createdAt, rangeStart),
    lt(directExecutions.createdAt, rangeEnd),
  ];

  if (status) {
    const dbStatuses = directDbStatuses(status);
    conditions.push(
      sql`${directExecutions.status} IN (${sql.join(
        dbStatuses.map((s) => sql`${s}`),
        sql`, `
      )})`
    );
  }

  if (cursor) {
    conditions.push(lt(directExecutions.createdAt, new Date(cursor)));
  }

  const result = await db
    .select({
      id: directExecutions.id,
      status: directExecutions.status,
      createdAt: directExecutions.createdAt,
      completedAt: directExecutions.completedAt,
      type: directExecutions.type,
      network: directExecutions.network,
      transactionHash: directExecutions.transactionHash,
      gasUsedWei: directExecutions.gasUsedWei,
    })
    .from(directExecutions)
    .where(and(...conditions))
    .orderBy(desc(directExecutions.createdAt))
    .limit(limit);

  return result.map((row) => ({
    id: row.id,
    source: "direct" as const,
    status: normalizeStatus(row.status, "direct"),
    startedAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.completedAt
      ? row.completedAt.getTime() - row.createdAt.getTime()
      : null,
    workflowId: null,
    workflowName: null,
    directType: row.type as UnifiedRun["directType"],
    network: row.network,
    // Direct executions are genuinely single-tx. Synthesize the entry so
    // consumers can render workflow + direct runs through the same array
    // shape; nodeId/nodeName carry sentinel values since direct executions
    // have no canvas node. Consumers must discriminate on `source === "direct"`
    // rather than the nodeId/nodeName literals -- a workflow node could
    // theoretically share the same id, and the sentinel is presentational.
    transactionHashes: row.transactionHash
      ? [
          {
            hash: row.transactionHash,
            nodeId: "direct",
            nodeName: "Direct execution",
            ...(row.network ? { network: row.network } : {}),
          },
        ]
      : [],
    gasUsedWei: row.gasUsedWei,
    totalSteps: null,
    completedSteps: null,
  }));
}

async function getWorkflowRunsTotal(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined,
  projectId?: string
): Promise<number> {
  const conditions = [
    eq(workflows.organizationId, organizationId),
    gte(workflowExecutions.startedAt, rangeStart),
    lt(workflowExecutions.startedAt, rangeEnd),
  ];
  if (projectId) {
    conditions.push(eq(workflows.projectId, projectId));
  }
  if (status) {
    const dbStatuses = workflowDbStatuses(status);
    conditions.push(
      sql`${workflowExecutions.status} IN (${sql.join(
        dbStatuses.map((s) => sql`${s}`),
        sql`, `
      )})`
    );
  }
  const result = await db
    .select({ count: count() })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(and(...conditions));
  return Number(result[0]?.count) || 0;
}

async function getDirectRunsTotal(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined
): Promise<number> {
  const conditions = [
    eq(directExecutions.organizationId, organizationId),
    gte(directExecutions.createdAt, rangeStart),
    lt(directExecutions.createdAt, rangeEnd),
  ];
  if (status) {
    const dbStatuses = directDbStatuses(status);
    conditions.push(
      sql`${directExecutions.status} IN (${sql.join(
        dbStatuses.map((s) => sql`${s}`),
        sql`, `
      )})`
    );
  }
  const result = await db
    .select({ count: count() })
    .from(directExecutions)
    .where(and(...conditions));
  return Number(result[0]?.count) || 0;
}

async function getUnifiedRunsTotal(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined,
  source: RunSource | undefined,
  projectId?: string
): Promise<number> {
  const skipDirect = Boolean(projectId);

  // Run both count queries in parallel
  const [workflowTotal, directTotal] = await Promise.all([
    source === "direct"
      ? 0
      : getWorkflowRunsTotal(
          organizationId,
          rangeStart,
          rangeEnd,
          status,
          projectId
        ),
    skipDirect || source === "workflow"
      ? 0
      : getDirectRunsTotal(organizationId, rangeStart, rangeEnd, status),
  ]);

  return workflowTotal + directTotal;
}

/**
 * Fetch step-level logs for a workflow execution.
 */
export async function getStepLogs(
  executionId: string,
  organizationId: string
): Promise<StepLog[]> {
  const result = await db
    .select({
      id: workflowExecutionLogs.id,
      nodeId: workflowExecutionLogs.nodeId,
      nodeName: workflowExecutionLogs.nodeName,
      nodeType: workflowExecutionLogs.nodeType,
      status: workflowExecutionLogs.status,
      startedAt: workflowExecutionLogs.startedAt,
      completedAt: workflowExecutionLogs.completedAt,
      duration: workflowExecutionLogs.duration,
      error: workflowExecutionLogs.error,
      iterationIndex: workflowExecutionLogs.iterationIndex,
      forEachNodeId: workflowExecutionLogs.forEachNodeId,
    })
    .from(workflowExecutionLogs)
    .innerJoin(
      workflowExecutions,
      eq(workflowExecutionLogs.executionId, workflowExecutions.id)
    )
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflows.organizationId, organizationId)
      )
    )
    .orderBy(workflowExecutionLogs.startedAt);

  return result.map((row) => ({
    id: row.id,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    nodeType: row.nodeType,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.duration ? Number(row.duration) : null,
    error: row.error,
    iterationIndex: row.iterationIndex,
    forEachNodeId: row.forEachNodeId,
  }));
}

/**
 * Get the spend cap and daily usage for an organization.
 */
export async function getSpendCapData(organizationId: string): Promise<{
  dailyCapWei: string | null;
  dailyUsedWei: string;
}> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [capResult, directUsageResult, workflowUsageResult] = await Promise.all(
    [
      db
        .select({ dailyCapWei: organizationSpendCaps.dailyCapWei })
        .from(organizationSpendCaps)
        .where(eq(organizationSpendCaps.organizationId, organizationId))
        .limit(1),
      db
        .select({
          totalWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
        })
        .from(directExecutions)
        .where(
          and(
            eq(directExecutions.organizationId, organizationId),
            eq(directExecutions.status, "completed"),
            gte(directExecutions.createdAt, todayStart)
          )
        ),
      db
        // Same denormalised-column read as getWorkflowGasTotal: today's run
        // gas straight off workflow_executions, no logs JSONB scan. gas_used_wei
        // already reflects only gas-bearing (success) step output, so the
        // previous log status='success' filter is subsumed. Windowed by run
        // start rather than per-step time (see getWorkflowGasTotal).
        .select({
          totalWei: sql<string>`COALESCE(SUM(CAST(${workflowExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
        })
        .from(workflowExecutions)
        .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
        .where(
          and(
            eq(workflows.organizationId, organizationId),
            gte(workflowExecutions.startedAt, todayStart)
          )
        ),
    ]
  );

  return {
    dailyCapWei: capResult[0]?.dailyCapWei ?? null,
    dailyUsedWei: addBigIntStrings(
      directUsageResult[0]?.totalWei ?? "0",
      workflowUsageResult[0]?.totalWei ?? "0"
    ),
  };
}

/**
 * Get a lightweight checksum for SSE change detection.
 * Returns max timestamps + active count so we know when to push updates.
 */
export async function getAnalyticsChecksum(
  organizationId: string
): Promise<string> {
  const [wfMax, deMax, activeCount] = await Promise.all([
    db
      .select({
        maxStarted: sql<string>`COALESCE(MAX(${workflowExecutions.startedAt}), '1970-01-01')::text`,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(eq(workflows.organizationId, organizationId))
      .then((r) => r[0]?.maxStarted ?? ""),
    db
      .select({
        maxCreated: sql<string>`COALESCE(MAX(${directExecutions.createdAt}), '1970-01-01')::text`,
      })
      .from(directExecutions)
      .where(eq(directExecutions.organizationId, organizationId))
      .then((r) => r[0]?.maxCreated ?? ""),
    db
      .select({ count: count() })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(
        and(
          eq(workflows.organizationId, organizationId),
          sql`${workflowExecutions.status} IN ('pending', 'running')`
        )
      )
      .then((r) => Number(r[0]?.count) || 0),
  ]);

  return `${wfMax}|${deMax}|${activeCount}`;
}
