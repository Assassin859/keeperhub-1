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
 * Deployment: invoked by a Kubernetes CronJob every 5 minutes (the
 * `security-behavioral-scan` job in `deploy/keeperhub/{prod,staging}/
 * values.yaml`, which runs `deploy/scripts/reaper.sh` against this path).
 * Authorized via the internal-service HMAC scheme (`X-KH-Caller`,
 * `X-KH-Timestamp`, `X-KH-Signature` signed with
 * `INTERNAL_SERVICE_HMAC_SECRET`) through `authenticateInternalService`,
 * the same mechanism the reaper CronJob uses -- so scheduling reuses the
 * existing shared signing secret rather than provisioning a dedicated cron
 * secret. The endpoint fails closed when the signature does not verify;
 * there is no NODE_ENV dev/test bypass, so a prod container that boots with
 * `NODE_ENV=test` (the misconfig the v2 review flagged) cannot accidentally
 * open the endpoint. Local dev signs with `INTERNAL_SERVICE_HMAC_SECRET`
 * (see `deploy/scripts/reaper.sh`) to invoke via curl.
 *
 * Detection windows are deliberately overlapping so a transient blip in
 * scheduler timing doesn't drop an event: the CronJob fires every 5
 * minutes but EXECUTION_LOOKBACK_MS is 10 minutes, so every execution is
 * read by two consecutive scans and a single late/skipped run still
 * leaves it covered. Idempotency comes from the downstream alert layer
 * (the `new_account_first_workflow` Loki rule evaluates a 10-minute
 * window and fires on >=1 occurrence, so the duplicate emissions collapse
 * to a single page), not from this endpoint.
 */

import { captureMessage } from "@sentry/nextjs";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, workflowExecutions } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";

export const dynamic = "force-dynamic";

const NEW_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
// Wider than the 5-minute CronJob interval so consecutive scans overlap and
// scheduler jitter cannot drop an execution from coverage. Matched to the
// 10-minute window of the downstream `new_account_first_workflow` Loki alert
// (relative_time_range from=600 in keeperhub-security-alerts.tf) so the
// resulting duplicate emissions dedupe to a single page.
const EXECUTION_LOOKBACK_MS = 10 * 60 * 1000;

type BehavioralScanResponse = {
  newAccountFirstWorkflowEvents: number;
  durationMs: number;
};

async function scanNewAccountFirstWorkflow(
  startedAt: number
): Promise<BehavioralScanResponse> {
  const now = new Date();
  const accountFloor = new Date(now.getTime() - NEW_ACCOUNT_WINDOW_MS);
  const executionFloor = new Date(now.getTime() - EXECUTION_LOOKBACK_MS);

  // New-account-first-workflow: any execution within the EXECUTION_LOOKBACK_MS
  // window (10 minutes) owned by a user whose account is newer than the
  // 15-minute floor. The join captures the user's signup age so the alert
  // can carry it.
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

  return {
    newAccountFirstWorkflowEvents: rows.length,
    durationMs: Date.now() - startedAt,
  };
}

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();

  // Fail closed via the shared internal-service auth: the CronJob signs the
  // request with the HMAC scheme (X-KH-Caller/Timestamp/Signature, see
  // reaper.sh), which resolves to caller "scheduler". Scoped to that caller
  // specifically -- the mcp/events/hub/executor callers that also satisfy
  // authenticateInternalService have no business invoking a detection scan,
  // so least-privilege rejects them. No NODE_ENV bypass: when the signature
  // does not verify nothing matches.
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated || auth.caller !== "scheduler") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await scanNewAccountFirstWorkflow(startedAt);
    return Response.json(body);
  } catch (error) {
    // The scan itself failed (e.g. a DB error). Swallowing silently would
    // drop detection to zero with no signal -- and reaper.sh reports a
    // non-2xx as a "successful" job (curl -sS, no -f), so a broken scan
    // would otherwise look healthy. Emit a self-failure signal (self-guarded,
    // dual transport) so the detection layer going dark is itself observable,
    // then surface a 500. Mirrors content-scanner's security.content_scanner_error.
    const message = error instanceof Error ? error.message : String(error);
    try {
      captureMessage("security.behavioral.scan_error", {
        level: "error",
        tags: { security: "behavioral.scan_error" },
        extra: { message, durationMs: Date.now() - startedAt },
      });
    } catch {
      // never let the failure-signal emission mask the original error
    }
    console.error(
      JSON.stringify({
        event: "security.behavioral.scan_error",
        message,
        durationMs: Date.now() - startedAt,
      })
    );
    return Response.json({ error: "scan_failed" }, { status: 500 });
  }
}
