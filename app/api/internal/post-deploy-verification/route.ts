/**
 * Post-deployment verification for managed and enterprise organizations.
 *
 * Reads recent workflow execution outcomes for the white-glove cohort
 * (MANAGED_ORG_SLUGS plus any org on an `enterprise` subscription) and reports
 * whether any of them are erroring after a deploy. Authenticated as an internal
 * service (HMAC) and invoked from the post-deploy-verification CI job, which
 * runs inside the cluster against the in-pod service URL (the public hostname
 * is WAF-blocked for /api/internal/*).
 *
 * An org is flagged as a problem when:
 *   - it produced any `system_error` executions in the window (platform/infra
 *     faults are the strongest signal of a deploy regression), OR
 *   - it ran at least `minExecutions` and its error rate exceeds `maxErrorRate`.
 *
 * This is a stateless single check (one query per request); the CI job owns the
 * timing and polls it. Window and thresholds are query-param overridable so the
 * job can tune them without a redeploy: `since` (unix seconds, the window
 * anchor), `lookbackMinutes` (fallback when `since` is absent), `minExecutions`,
 * and `maxErrorRate`.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  organization,
  organizationSubscriptions,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { ERROR_STATUSES } from "@/lib/errors/execution-status";
import { HttpStatus } from "@/lib/http-status";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import { MANAGED_ORG_SLUGS } from "@/lib/orgs/managed-clients";

const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_MIN_EXECUTIONS = 1;
const DEFAULT_MAX_ERROR_RATE = 0.5;
const SAMPLE_ERRORS_PER_ORG = 3;
const MAX_SAMPLE_ERROR_LENGTH = 300;

type TargetOrg = {
  id: string;
  slug: string;
  name: string;
  plan: string;
};

type OrgVerification = {
  organizationId: string;
  slug: string;
  name: string;
  plan: string;
  total: number;
  success: number;
  userErrors: number;
  systemErrors: number;
  errorRate: number;
  isProblem: boolean;
  reasons: string[];
  sampleErrors: string[];
};

function parseNumberParam(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function resolveTargetOrgs(): Promise<TargetOrg[]> {
  const rows = await db
    .select({
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      plan: organizationSubscriptions.plan,
    })
    .from(organization)
    .leftJoin(
      organizationSubscriptions,
      eq(organizationSubscriptions.organizationId, organization.id)
    )
    .where(
      and(
        isNull(organization.deactivatedAt),
        or(
          inArray(organization.slug, [...MANAGED_ORG_SLUGS]),
          eq(organizationSubscriptions.plan, "enterprise")
        )
      )
    );

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    plan: row.plan ?? "free",
  }));
}

async function fetchSampleErrors(
  problemOrgIds: string[],
  since: Date
): Promise<Map<string, string[]>> {
  const byOrg = new Map<string, string[]>();
  if (problemOrgIds.length === 0) {
    return byOrg;
  }

  const rows = await db
    .select({
      organizationId: workflows.organizationId,
      error: workflowExecutions.error,
      status: workflowExecutions.status,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(
      and(
        inArray(workflows.organizationId, problemOrgIds),
        gte(workflowExecutions.startedAt, since),
        inArray(workflowExecutions.status, [...ERROR_STATUSES])
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(problemOrgIds.length * SAMPLE_ERRORS_PER_ORG * 4);

  for (const row of rows) {
    const orgId = row.organizationId;
    if (!orgId) {
      continue;
    }
    const existing = byOrg.get(orgId) ?? [];
    if (existing.length >= SAMPLE_ERRORS_PER_ORG) {
      continue;
    }
    const message = (row.error ?? "(no error message)").slice(
      0,
      MAX_SAMPLE_ERROR_LENGTH
    );
    existing.push(`[${row.status}] ${message}`);
    byOrg.set(orgId, existing);
  }

  return byOrg;
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const url = new URL(request.url);
  const lookbackMinutes = parseNumberParam(
    url.searchParams.get("lookbackMinutes"),
    DEFAULT_LOOKBACK_MINUTES
  );
  const minExecutions = parseNumberParam(
    url.searchParams.get("minExecutions"),
    DEFAULT_MIN_EXECUTIONS
  );
  const maxErrorRate = parseNumberParam(
    url.searchParams.get("maxErrorRate"),
    DEFAULT_MAX_ERROR_RATE
  );

  // Stateless single check: one query per request. The CI job owns the timing
  // (it polls this endpoint). `since` (unix seconds) is the window anchor the
  // caller passes so a poll counts only executions that started after the
  // deploy -- i.e. runs on the new build. Falls back to the backward lookback
  // window when omitted.
  const sinceParam = url.searchParams.get("since");
  const sinceEpoch = sinceParam ? Number.parseInt(sinceParam, 10) : Number.NaN;
  const since = Number.isFinite(sinceEpoch)
    ? new Date(sinceEpoch * 1000)
    : new Date(Date.now() - lookbackMinutes * 60 * 1000);

  try {
    const windowStart = since.toISOString();
    const targetOrgs = await resolveTargetOrgs();

    if (targetOrgs.length === 0) {
      return NextResponse.json({
        ok: true,
        windowStart,
        minExecutions,
        maxErrorRate,
        checkedOrgs: 0,
        problemCount: 0,
        totalExecutions: 0,
        orgs: [],
        problems: [],
        generatedAt: new Date().toISOString(),
      });
    }

    const orgIds = targetOrgs.map((org) => org.id);
    const statsRows = await db
      .select({
        organizationId: workflows.organizationId,
        total: sql<number>`COUNT(*)`,
        success: sql<number>`COUNT(*) FILTER (WHERE ${workflowExecutions.status} = 'success')`,
        userErrors: sql<number>`COUNT(*) FILTER (WHERE ${workflowExecutions.status} = 'error')`,
        systemErrors: sql<number>`COUNT(*) FILTER (WHERE ${workflowExecutions.status} = 'system_error')`,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
      .where(
        and(
          inArray(workflows.organizationId, orgIds),
          gte(workflowExecutions.startedAt, since)
        )
      )
      .groupBy(workflows.organizationId);

    const statsByOrg = new Map(
      statsRows.map((row) => [
        row.organizationId,
        {
          total: Number(row.total),
          success: Number(row.success),
          userErrors: Number(row.userErrors),
          systemErrors: Number(row.systemErrors),
        },
      ])
    );

    const orgs: OrgVerification[] = targetOrgs.map((org) => {
      const stats = statsByOrg.get(org.id) ?? {
        total: 0,
        success: 0,
        userErrors: 0,
        systemErrors: 0,
      };
      const errorCount = stats.userErrors + stats.systemErrors;
      const errorRate = stats.total > 0 ? errorCount / stats.total : 0;

      const reasons: string[] = [];
      if (stats.systemErrors > 0) {
        reasons.push(`${stats.systemErrors} system_error execution(s)`);
      }
      if (stats.total >= minExecutions && errorRate > maxErrorRate) {
        reasons.push(
          `error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(
            maxErrorRate * 100
          ).toFixed(1)}% over ${stats.total} execution(s)`
        );
      }

      return {
        organizationId: org.id,
        slug: org.slug,
        name: org.name,
        plan: org.plan,
        total: stats.total,
        success: stats.success,
        userErrors: stats.userErrors,
        systemErrors: stats.systemErrors,
        errorRate,
        isProblem: reasons.length > 0,
        reasons,
        sampleErrors: [],
      };
    });

    const problemOrgIds = orgs
      .filter((org) => org.isProblem)
      .map((org) => org.organizationId);
    const sampleErrors = await fetchSampleErrors(problemOrgIds, since);
    for (const org of orgs) {
      if (org.isProblem) {
        org.sampleErrors = sampleErrors.get(org.organizationId) ?? [];
      }
    }

    const problems = orgs.filter((org) => org.isProblem);
    const totalExecutions = orgs.reduce((sum, org) => sum + org.total, 0);

    // The per-org detail (slugs, names, sample error text) is customer data and
    // must not surface in the public-repo CI logs or an external Discord channel.
    // Emit it to internal observability (Loki) instead, where operators look up
    // specifics; the CI job only ever reports aggregate counts.
    if (problems.length > 0) {
      logSystemWarn(
        ErrorCategory.WORKFLOW_ENGINE,
        "Post-deploy verification flagged managed/enterprise org errors",
        undefined,
        {
          problem_count: String(problems.length),
          checked_orgs: String(orgs.length),
          window_start: windowStart,
          problems: JSON.stringify(
            problems.map((org) => ({
              slug: org.slug,
              plan: org.plan,
              total: org.total,
              userErrors: org.userErrors,
              systemErrors: org.systemErrors,
              reasons: org.reasons,
              sampleErrors: org.sampleErrors,
            }))
          ),
        }
      );
    }

    return NextResponse.json({
      ok: problems.length === 0,
      windowStart,
      minExecutions,
      maxErrorRate,
      checkedOrgs: orgs.length,
      problemCount: problems.length,
      totalExecutions,
      orgs,
      problems,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to run post-deploy verification",
      error,
      { endpoint: "/api/internal/post-deploy-verification", operation: "get" }
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to run post-deploy verification",
      },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}
