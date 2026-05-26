/**
 * KEEP-612 behavioral detection cron. Periodic queries against the
 * attribution columns added in migration 0088 (workflow_executions.user_id,
 * started_at, triggered_by_org_api_key_id, triggered_by_country) plus the
 * users table to surface signals that grafana/prometheus can't compute
 * because the substrate lives in Postgres, not the metrics pipeline.
 *
 * Emits structured `security.behavioral.*` log lines that the Loki alert
 * rules in `techops_infrastructure/keeperhub-security-alerts.tf` key off.
 * One log line per detected event so triage can pivot by user/key without
 * having to re-run the query.
 *
 * Deployment: invoked by an external scheduler (Kubernetes CronJob)
 * every 5 minutes. Authorized via `Authorization: Bearer $CRON_SECRET`
 * the same way `app/api/cron/agentic-wallet-sweeper` is. Dev/test
 * bypasses the check.
 *
 * Detection windows are deliberately overlapping so a transient blip in
 * scheduler timing doesn't drop an event. Idempotency comes from the
 * downstream alert layer (Loki dedupe within the alert group window),
 * not from this endpoint.
 */

import { captureMessage } from "@sentry/nextjs";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, workflowExecutions } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const NEW_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const EXECUTION_LOOKBACK_MS = 5 * 60 * 1000;

type BehavioralScanResponse = {
  newAccountFirstWorkflowEvents: number;
  durationMs: number;
};

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  // If a secret is configured, always enforce it -- defends against the
  // misconfiguration shape "container booted with NODE_ENV=test in prod".
  if (expected) {
    const header = request.headers.get("authorization");
    return header === `Bearer ${expected}`;
  }
  // No secret configured -- only safe to bypass in dev/test environments
  // where local tooling needs to hit the endpoint via curl.
  return (
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
  );
}

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();

  if (!isAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const accountFloor = new Date(now.getTime() - NEW_ACCOUNT_WINDOW_MS);
  const executionFloor = new Date(now.getTime() - EXECUTION_LOOKBACK_MS);

  // New-account-first-workflow: any execution within the last 5 minutes
  // owned by a user whose account is newer than the 15-minute floor. The
  // join captures the user's signup age so the alert can carry it.
  const rows = await db
    .select({
      userId: workflowExecutions.userId,
      workflowId: workflowExecutions.workflowId,
      executionId: workflowExecutions.id,
      triggerSource: workflowExecutions.triggerSource,
      triggeredByCountry: workflowExecutions.triggeredByCountry,
      userCreatedAt: users.createdAt,
      executionStartedAt: workflowExecutions.startedAt,
    })
    .from(workflowExecutions)
    .innerJoin(users, eq(users.id, workflowExecutions.userId))
    .where(
      and(
        gt(workflowExecutions.startedAt, executionFloor),
        gt(users.createdAt, accountFloor),
        isNotNull(workflowExecutions.userId)
      )
    );

  for (const row of rows) {
    const ageSeconds = Math.max(
      0,
      Math.round(
        (row.executionStartedAt.getTime() - row.userCreatedAt.getTime()) / 1000
      )
    );
    // Dual emit (Sentry + structured stdout) mirrors the pattern used by
    // the other detection signals in lib/security/* -- alert lands even if
    // one transport fails, and Sentry's UI gives triagers richer pivots
    // than raw Loki JSON.
    try {
      captureMessage("security.behavioral.new_account_first_workflow", {
        level: "warning",
        tags: {
          security: "behavioral.new_account_first_workflow",
          trigger_source: row.triggerSource ?? "unknown",
        },
        user: { id: row.userId },
        extra: {
          workflowId: row.workflowId,
          executionId: row.executionId,
          triggeredByCountry: row.triggeredByCountry,
          ageSecondsSinceSignup: ageSeconds,
        },
      });
    } catch {
      // swallow; observability must not interrupt the scan
    }
    console.warn(
      JSON.stringify({
        event: "security.behavioral.new_account_first_workflow",
        userId: row.userId,
        workflowId: row.workflowId,
        executionId: row.executionId,
        triggerSource: row.triggerSource,
        triggeredByCountry: row.triggeredByCountry,
        ageSecondsSinceSignup: ageSeconds,
      })
    );
  }

  const body: BehavioralScanResponse = {
    newAccountFirstWorkflowEvents: rows.length,
    durationMs: Date.now() - startedAt,
  };
  return Response.json(body);
}
