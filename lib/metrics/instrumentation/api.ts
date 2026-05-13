/**
 * API Metrics Instrumentation
 *
 * Helper functions to instrument API routes with golden signal metrics.
 */

import { getMetricsCollector } from "../index";
import { LabelKeys, MetricNames } from "../types";

/**
 * Record webhook trigger metrics.
 *
 * Optional org identifiers (`orgId`, `orgSlug`, `orgName`) are attached as
 * labels on the emitted `api.errors.total` event. They show up in the console
 * JSON log (shipped to Loki) so operators can identify which organization
 * triggered a failure response. `org_id` and `org_name` are dropped from the
 * Prometheus counter via the metric allowlist to keep cardinality bounded;
 * `org_slug` is allowlisted and becomes a Prometheus label.
 */
export function recordWebhookMetrics(options: {
  workflowId: string;
  executionId?: string;
  durationMs: number;
  statusCode: number;
  error?: string;
  orgId?: string | null;
  orgSlug?: string;
  orgName?: string;
}): void {
  const metrics = getMetricsCollector();
  const success = options.statusCode < 400;

  const labels: Record<string, string> = {
    [LabelKeys.STATUS_CODE]: String(options.statusCode),
    [LabelKeys.STATUS]: success ? "success" : "failure",
  };

  metrics.recordLatency(
    MetricNames.API_WEBHOOK_LATENCY,
    options.durationMs,
    labels
  );

  if (!success && options.error) {
    const errorLabels: Record<string, string> = {
      [LabelKeys.ENDPOINT]: "webhook",
      [LabelKeys.STATUS_CODE]: String(options.statusCode),
    };
    if (options.orgId) {
      errorLabels[LabelKeys.ORG_ID] = options.orgId;
    }
    if (options.orgSlug) {
      errorLabels[LabelKeys.ORG_SLUG] = options.orgSlug;
    }
    if (options.orgName) {
      errorLabels[LabelKeys.ORG_NAME] = options.orgName;
    }

    metrics.recordError(
      MetricNames.API_ERRORS_TOTAL,
      { message: options.error },
      errorLabels
    );
  }
}

/**
 * Record status polling metrics
 */
export function recordStatusPollMetrics(options: {
  executionId: string;
  durationMs: number;
  statusCode: number;
  executionStatus?: string;
}): void {
  const metrics = getMetricsCollector();

  metrics.recordLatency(MetricNames.API_STATUS_LATENCY, options.durationMs, {
    [LabelKeys.STATUS_CODE]: String(options.statusCode),
    [LabelKeys.STATUS]: options.statusCode < 400 ? "success" : "failure",
    execution_status: options.executionStatus ?? "unknown",
  });
}
