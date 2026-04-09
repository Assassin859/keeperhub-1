/**
 * Prometheus Metrics Collector
 *
 * Exports metrics in Prometheus format for scraping.
 * Uses prom-client library for metric types and registry.
 */

import "server-only";

import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { ErrorContext, MetricLabels, MetricsCollector } from "../types";

// Use global singletons to prevent duplicate registration during hot reload
// This is safe because each pod has its own Node.js process
const globalForProm = globalThis as unknown as {
  dbRegistry: Registry | undefined;
  apiRegistry: Registry | undefined;
};

// Two registries: DB-sourced gauges (identical across pods) and API-process metrics (per-pod)
const dbRegistry = globalForProm.dbRegistry ?? new Registry();
globalForProm.dbRegistry = dbRegistry;

const apiRegistry = globalForProm.apiRegistry ?? new Registry();
globalForProm.apiRegistry = apiRegistry;

// Pre-defined label names for each metric
const _WORKFLOW_LABELS = [
  "workflow_id",
  "execution_id",
  "trigger_type",
  "status",
];
const _STEP_LABELS = ["execution_id", "step_type", "status"];
const _API_LABELS = ["endpoint", "status_code", "status"];
const WEBHOOK_LABELS = ["status_code", "status"];
const PLUGIN_LABELS = ["plugin_name", "action_name", "status"];
const _ERROR_LABELS = ["error_type", "plugin_name", "action_name", "service"];
const DB_LABELS = ["query_type", "threshold"];
const POOL_LABELS = ["active", "max"];

/**
 * Helper to get or create a metric (handles hot reload gracefully)
 */
function getOrCreateHistogram(
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[],
  buckets: number[]
): Histogram {
  const existing = registry.getSingleMetric(name);
  if (existing) {
    return existing as Histogram;
  }
  return new Histogram({
    name,
    help,
    labelNames,
    buckets,
    registers: [registry],
  });
}

function getOrCreateCounter(
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[]
): Counter {
  const existing = registry.getSingleMetric(name);
  if (existing) {
    return existing as Counter;
  }
  return new Counter({ name, help, labelNames, registers: [registry] });
}

function getOrCreateGauge(
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[]
): Gauge {
  const existing = registry.getSingleMetric(name);
  if (existing) {
    return existing as Gauge;
  }
  return new Gauge({ name, help, labelNames, registers: [registry] });
}

// DB-sourced workflow metrics → dbRegistry (identical across pods, scrape one)
// Workflow runner jobs exit before Prometheus can scrape - data must come from DB.
//
// All metrics are GAUGES (point-in-time snapshots). Use max() aggregation across pods.
// For rate/delta queries, use PromQL delta() function: max(delta(metric[1h]))

// Workflow execution counts by status
const workflowExecutionsTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_executions_total",
  "Total workflow executions by status (all-time)",
  ["status"]
);

// Workflow errors total (convenience gauge for alerting)
const workflowErrorsTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_execution_errors_total",
  "Total failed workflow executions (all-time)",
  []
);

// Workflow duration histogram as gauges (replaces histogram)
const workflowDurationBucket = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_execution_duration_ms_bucket",
  "Workflow execution duration histogram buckets",
  ["le"]
);

const workflowDurationSum = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_execution_duration_ms_sum",
  "Sum of workflow execution durations",
  []
);

const workflowDurationCount = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_execution_duration_ms_count",
  "Count of workflow executions with duration",
  []
);

// Step execution counts by status (populated from DB)
const stepExecutionsTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_step_executions_total",
  "Total workflow step executions",
  ["step_type", "status"]
);

// Step errors (derived from step executions with status=error)
const stepErrorsTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_step_errors_total",
  "Failed step executions",
  ["step_type"]
);

// Step duration histogram as gauges
const stepDurationBucket = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_step_duration_ms_bucket",
  "Workflow step duration histogram buckets",
  ["le"]
);

const stepDurationSum = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_step_duration_ms_sum",
  "Sum of workflow step durations",
  []
);

const stepDurationCount = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_step_duration_ms_count",
  "Count of workflow steps with duration",
  []
);

// Saturation gauges (DB-sourced)
const workflowQueueDepth = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_queue_depth",
  "Pending workflow jobs in queue",
  []
);

const workflowConcurrent = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_concurrent_count",
  "Current concurrent workflow executions",
  []
);

const activeUsers = getOrCreateGauge(
  dbRegistry,
  "keeperhub_user_active_daily",
  "Daily active users",
  []
);

// User metrics (DB-sourced)
const userTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_user_total",
  "Total registered users",
  []
);

const userVerified = getOrCreateGauge(
  dbRegistry,
  "keeperhub_user_verified_total",
  "Users with verified email",
  []
);

const userAnonymous = getOrCreateGauge(
  dbRegistry,
  "keeperhub_user_anonymous_total",
  "Anonymous users",
  []
);

const userWithWorkflows = getOrCreateGauge(
  dbRegistry,
  "keeperhub_user_with_workflows_total",
  "Users who have created at least one workflow",
  []
);

const userWithIntegrations = getOrCreateGauge(
  dbRegistry,
  "keeperhub_user_with_integrations_total",
  "Users who have configured at least one integration",
  []
);

// User info gauge (DB-sourced, one series per user)
const userInfo = getOrCreateGauge(
  dbRegistry,
  "keeperhub_user_info",
  "User info with email and name labels",
  ["email", "name", "verified", "created_at"]
);

// Organization metrics (DB-sourced)
const orgTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_org_total",
  "Total organizations",
  []
);

const orgMembersTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_org_members_total",
  "Total organization members across all orgs",
  []
);

const orgMembersByRole = getOrCreateGauge(
  dbRegistry,
  "keeperhub_org_members_by_role",
  "Organization members by role",
  ["role"]
);

const orgInvitationsPending = getOrCreateGauge(
  dbRegistry,
  "keeperhub_org_invitations_pending",
  "Pending organization invitations",
  []
);

const orgWithWorkflows = getOrCreateGauge(
  dbRegistry,
  "keeperhub_org_with_workflows_total",
  "Organizations with at least one workflow",
  []
);

// Organization info gauge (DB-sourced, one series per org)
const orgInfo = getOrCreateGauge(
  dbRegistry,
  "keeperhub_org_info",
  "Organization info with name and slug labels",
  ["org_name", "slug"]
);

// Workflow definition metrics (DB-sourced)
const workflowTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_total",
  "Total workflow definitions",
  []
);

const workflowByVisibility = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_by_visibility",
  "Workflows by visibility",
  ["visibility"]
);

const workflowAnonymous = getOrCreateGauge(
  dbRegistry,
  "keeperhub_workflow_anonymous_total",
  "Anonymous workflows",
  []
);

// Schedule metrics (DB-sourced)
const scheduleTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_schedule_total",
  "Total workflow schedules",
  []
);

const scheduleEnabled = getOrCreateGauge(
  dbRegistry,
  "keeperhub_schedule_enabled_total",
  "Enabled workflow schedules",
  []
);

const scheduleByLastStatus = getOrCreateGauge(
  dbRegistry,
  "keeperhub_schedule_by_last_status",
  "Schedules by last run status",
  ["status"]
);

// Integration metrics (DB-sourced)
const integrationTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_integration_total",
  "Total integrations",
  []
);

const integrationManaged = getOrCreateGauge(
  dbRegistry,
  "keeperhub_integration_managed_total",
  "OAuth-managed integrations",
  []
);

const integrationByType = getOrCreateGauge(
  dbRegistry,
  "keeperhub_integration_by_type",
  "Integrations by type",
  ["type"]
);

// Infrastructure metrics (DB-sourced)
const apiKeyTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_apikey_total",
  "Total API keys",
  []
);

const chainTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_chain_total",
  "Total blockchain networks configured",
  []
);

const chainEnabled = getOrCreateGauge(
  dbRegistry,
  "keeperhub_chain_enabled_total",
  "Enabled blockchain networks",
  []
);

const paraWalletTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_para_wallet_total",
  "Total Para wallets",
  []
);

const sessionActive = getOrCreateGauge(
  dbRegistry,
  "keeperhub_session_active_total",
  "Active (non-expired) sessions",
  []
);

// Hub vote metrics (DB-sourced)
const hubVotesTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_hub_votes_total",
  "Total hub workflow votes by direction",
  ["direction"]
);

const hubWorkflowScore = getOrCreateGauge(
  dbRegistry,
  "keeperhub_hub_workflow_score",
  "Top hub workflow scores",
  ["workflow_id"]
);

const hubWorkflowClones = getOrCreateGauge(
  dbRegistry,
  "keeperhub_hub_workflow_clones",
  "Top cloned hub workflows",
  ["workflow_id"]
);

const hubUserVotesTotal = getOrCreateGauge(
  dbRegistry,
  "keeperhub_hub_user_votes_total",
  "Top voters by vote count",
  ["user_id"]
);

// RPC failover metrics → apiRegistry (per-pod in-memory, scrape all pods)
// Per-request counters include "operation" label (read/write)
const RPC_CHAIN_LABELS = ["chain"];
const RPC_OPERATION_LABELS = ["chain", "operation"];

const rpcPrimaryAttempts = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_primary_attempts_total",
  "Total RPC requests attempted against primary endpoint",
  RPC_OPERATION_LABELS
);

const rpcPrimaryFailures = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_primary_failures_total",
  "Total RPC request failures on primary endpoint",
  RPC_OPERATION_LABELS
);

const rpcFallbackAttempts = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_fallback_attempts_total",
  "Total RPC requests attempted against fallback endpoint",
  RPC_OPERATION_LABELS
);

const rpcFallbackFailures = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_fallback_failures_total",
  "Total RPC request failures on fallback endpoint",
  RPC_OPERATION_LABELS
);

const rpcFailoverEvents = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_failover_events_total",
  "Total times primary failed and traffic switched to fallback",
  RPC_CHAIN_LABELS
);

const rpcRecoveryEvents = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_recovery_events_total",
  "Total times primary recovered and traffic switched back from fallback",
  RPC_CHAIN_LABELS
);

const rpcBothFailedEvents = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_both_failed_total",
  "Total times both primary and fallback endpoints failed",
  RPC_CHAIN_LABELS
);

const rpcCurrentProvider = getOrCreateGauge(
  apiRegistry,
  "keeperhub_rpc_using_fallback",
  "Whether the chain is currently using the fallback RPC (1=fallback, 0=primary)",
  RPC_CHAIN_LABELS
);

const rpcHealthState = getOrCreateGauge(
  apiRegistry,
  "keeperhub_rpc_health_state",
  "RPC health state per chain (0=primary/healthy, 1=fallback/degraded, 2=both_failed/down)",
  RPC_CHAIN_LABELS
);

const RPC_PROVIDER_OPERATION_LABELS = ["chain", "provider", "operation"];

const rpcLatency = getOrCreateHistogram(
  apiRegistry,
  "keeperhub_rpc_latency_ms",
  "RPC request latency in milliseconds per chain and provider",
  RPC_PROVIDER_OPERATION_LABELS,
  [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000]
);

const RPC_ERROR_OPERATION_LABELS = [
  "chain",
  "provider",
  "error_type",
  "operation",
];

const rpcErrorsByType = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_errors_by_type_total",
  "RPC errors broken down by type (timeout, rate_limit, connection, rpc_error)",
  RPC_ERROR_OPERATION_LABELS
);

// Active RPC health probe metrics → apiRegistry
const RPC_PROBE_LABELS = ["chain", "provider"];
const RPC_PROBE_ERROR_LABELS = ["chain", "provider", "error_type"];

const RPC_PROBE_UP_LABELS = ["chain", "provider", "endpoint"];

const rpcProbeUp = getOrCreateGauge(
  apiRegistry,
  "keeperhub_rpc_probe_up",
  "Whether the RPC endpoint responded to the health probe (1=up, 0=down)",
  RPC_PROBE_UP_LABELS
);

const rpcProbeLatency = getOrCreateHistogram(
  apiRegistry,
  "keeperhub_rpc_probe_latency_ms",
  "Active health probe latency in milliseconds",
  RPC_PROBE_LABELS,
  [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 15_000]
);

const rpcProbeErrorsTotal = getOrCreateCounter(
  apiRegistry,
  "keeperhub_rpc_probe_errors_total",
  "Active health probe errors by type",
  RPC_PROBE_ERROR_LABELS
);

const rpcProbeLastSuccess = getOrCreateGauge(
  apiRegistry,
  "keeperhub_rpc_probe_last_success_timestamp",
  "Unix timestamp of last successful probe per endpoint",
  RPC_PROBE_LABELS
);

// API-process metrics → apiRegistry (per-pod in-memory, scrape all pods)
const webhookLatency = getOrCreateHistogram(
  apiRegistry,
  "keeperhub_api_webhook_latency_ms",
  "Webhook trigger response time in milliseconds",
  WEBHOOK_LABELS,
  [10, 25, 50, 100, 250, 500]
);

const statusLatency = getOrCreateHistogram(
  apiRegistry,
  "keeperhub_api_status_latency_ms",
  "Status polling response time in milliseconds",
  ["status_code", "status", "execution_status"],
  [5, 10, 25, 50, 100]
);

const pluginDuration = getOrCreateHistogram(
  apiRegistry,
  "keeperhub_plugin_action_duration_ms",
  "Plugin action execution duration in milliseconds",
  PLUGIN_LABELS,
  [50, 100, 250, 500, 1000, 2000, 5000]
);

const aiDuration = getOrCreateHistogram(
  apiRegistry,
  "keeperhub_ai_generation_duration_ms",
  "AI workflow generation duration in milliseconds",
  ["status"],
  [500, 1000, 2000, 5000, 10_000, 20_000]
);

// Sponsorship counters
const SPONSORSHIP_LABELS = ["chain_id", "organization_id"];

const sponsorshipTransactions = getOrCreateCounter(
  apiRegistry,
  "keeperhub_sponsorship_transactions_total",
  "Total sponsored transactions",
  SPONSORSHIP_LABELS
);

const sponsorshipGasUsed = getOrCreateCounter(
  apiRegistry,
  "keeperhub_sponsorship_gas_used_total",
  "Total gas units consumed by sponsored transactions",
  SPONSORSHIP_LABELS
);

const sponsorshipGasCostUsdMicro = getOrCreateCounter(
  apiRegistry,
  "keeperhub_sponsorship_gas_cost_usd_micro_total",
  "Total gas cost in micro-USD for sponsored transactions",
  SPONSORSHIP_LABELS
);

// Traffic counters
const pluginInvocations = getOrCreateCounter(
  apiRegistry,
  "keeperhub_plugin_invocations_total",
  "Total plugin invocations",
  ["plugin_name", "action_name"]
);

// Error counters
const pluginErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_plugin_action_errors_total",
  "Failed plugin actions",
  ["plugin_name", "action_name", "error_type"]
);

const apiErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_api_errors_total",
  "API errors by status code",
  ["endpoint", "status_code", "error_type"]
);

// Common labels for all error counters (allows any subset to be used)
const ERROR_LABELS = [
  "error_category",
  "error_context",
  "is_user_error",
  "error_type",
  "plugin_name",
  "action_name",
  "service",
  "chain_id",
  "table",
  "endpoint",
  "component",
  "workflow_id",
  "execution_id",
  "integration_id",
  "status_code",
];

// User-caused error counters (from unified logging system)
const userValidationErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_user_validation_total",
  "User validation errors",
  ERROR_LABELS
);

const userConfigurationErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_user_configuration_total",
  "User configuration errors",
  ERROR_LABELS
);

const externalServiceErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_external_service_total",
  "External service errors",
  ERROR_LABELS
);

const networkRpcErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_network_rpc_total",
  "Network and RPC errors",
  ERROR_LABELS
);

const transactionBlockchainErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_transaction_blockchain_total",
  "Transaction and blockchain errors",
  ERROR_LABELS
);

// System-caused error counters (from unified logging system)
const systemDatabaseErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_system_database_total",
  "System database errors",
  ERROR_LABELS
);

const systemAuthErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_system_auth_total",
  "System authentication errors",
  ERROR_LABELS
);

const systemInfrastructureErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_system_infrastructure_total",
  "System infrastructure errors",
  ERROR_LABELS
);

const systemWorkflowEngineErrors = getOrCreateCounter(
  apiRegistry,
  "keeperhub_errors_system_workflow_engine_total",
  "System workflow engine errors",
  ERROR_LABELS
);

const slowQueries = getOrCreateCounter(
  apiRegistry,
  "keeperhub_db_query_slow_total",
  "Slow database queries (>100ms)",
  DB_LABELS
);

// Saturation gauge (API-process, per-pod)
const dbPoolUtilization = getOrCreateGauge(
  apiRegistry,
  "keeperhub_db_pool_utilization_percent",
  "Database connection pool utilization percentage",
  POOL_LABELS
);

// Allowed labels per error metric (must match counter definitions)
const errorLabelAllowlist: Record<string, string[]> = {
  "workflow.execution.errors": ["workflow_id", "trigger_type", "error_type"],
  "workflow.step.errors": ["step_type", "error_type"],
  "plugin.action.errors": ["plugin_name", "action_name", "error_type"],
  "api.errors.total": ["endpoint", "status_code", "error_type"],
};

/**
 * Filter labels to only include allowed ones for a specific metric
 */
function filterLabelsForMetric(
  metricName: string,
  labels: Record<string, string>
): Record<string, string> {
  const allowed = errorLabelAllowlist[metricName];
  if (!allowed) {
    return labels;
  }

  const filtered: Record<string, string> = {};
  for (const key of allowed) {
    if (key in labels) {
      filtered[key] = labels[key];
    }
  }
  return filtered;
}

// Metric name to histogram/counter/gauge mapping
// Note: Workflow execution/step metrics are now DB-sourced gauges, not histograms/counters

// Metrics that are DB-sourced and should be silently ignored when called via runtime instrumentation
// These are populated from database queries in updateDbMetrics(), not from runtime calls
const dbSourcedMetrics = new Set([
  "workflow.execution.duration_ms",
  "workflow.step.duration_ms",
  "workflow.executions.total",
  "workflow.execution.errors",
  "workflow.step.errors",
  "workflow.queue.depth",
  "workflow.concurrent.count",
]);

const histogramMap: Record<string, Histogram> = {
  "api.webhook.latency_ms": webhookLatency,
  "api.status.latency_ms": statusLatency,
  "plugin.action.duration_ms": pluginDuration,
  "ai.generation.duration_ms": aiDuration,
};

const counterMap: Record<string, Counter> = {
  "plugin.invocations.total": pluginInvocations,
  "db.query.slow_count": slowQueries,
  "sponsorship.transactions.total": sponsorshipTransactions,
  "sponsorship.gas_used.total": sponsorshipGasUsed,
  "sponsorship.gas_cost_usd_micro.total": sponsorshipGasCostUsdMicro,
};

const errorCounterMap: Record<string, Counter> = {
  "plugin.action.errors": pluginErrors,
  "api.errors.total": apiErrors,
  // User-caused errors
  "errors.user.validation.total": userValidationErrors,
  "errors.user.configuration.total": userConfigurationErrors,
  "errors.external.service.total": externalServiceErrors,
  "errors.network.rpc.total": networkRpcErrors,
  "errors.transaction.blockchain.total": transactionBlockchainErrors,
  // System-caused errors
  "errors.system.database.total": systemDatabaseErrors,
  "errors.system.auth.total": systemAuthErrors,
  "errors.system.infrastructure.total": systemInfrastructureErrors,
  "errors.system.workflow_engine.total": systemWorkflowEngineErrors,
};

const gaugeMap: Record<string, Gauge> = {
  "db.pool.utilization": dbPoolUtilization,
  "workflow.queue.depth": workflowQueueDepth,
  "workflow.concurrent.count": workflowConcurrent,
  "user.active.daily": activeUsers,
};

/**
 * Convert labels to Prometheus-compatible format
 * Prometheus labels must be strings and use snake_case
 */
function sanitizeLabels(labels?: MetricLabels): Record<string, string> {
  if (!labels) {
    return {};
  }

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    // Convert to snake_case if needed
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    sanitized[snakeKey] = String(value);
  }
  return sanitized;
}

/**
 * Prometheus Metrics Collector
 */
export const prometheusMetricsCollector: MetricsCollector = {
  recordLatency(name: string, durationMs: number, labels?: MetricLabels): void {
    // Silently skip DB-sourced metrics (populated via updateDbMetrics)
    if (dbSourcedMetrics.has(name)) {
      return;
    }
    const histogram = histogramMap[name];
    if (histogram) {
      histogram.observe(sanitizeLabels(labels), durationMs);
    } else {
      console.warn(`[Prometheus] Unknown latency metric: ${name}`);
    }
  },

  incrementCounter(name: string, labels?: MetricLabels, value = 1): void {
    // Silently skip DB-sourced metrics (populated via updateDbMetrics)
    if (dbSourcedMetrics.has(name)) {
      return;
    }
    const counter = counterMap[name];
    if (counter) {
      counter.inc(sanitizeLabels(labels), value);
    } else {
      console.warn(`[Prometheus] Unknown counter metric: ${name}`);
    }
  },

  recordError(
    name: string,
    error: Error | ErrorContext,
    labels?: MetricLabels
  ): void {
    // Silently skip DB-sourced metrics (populated via updateDbMetrics)
    if (dbSourcedMetrics.has(name)) {
      return;
    }
    const counter = errorCounterMap[name];
    if (counter) {
      const sanitized = sanitizeLabels(labels);
      // Add error type from error object if available
      if ("code" in error && error.code) {
        sanitized.error_type = error.code;
      } else if (error instanceof Error) {
        sanitized.error_type = error.name || "Error";
      } else {
        // Default error type for plain objects without code
        sanitized.error_type = "UnknownError";
      }
      // Filter to only include labels defined for this counter
      const errorLabels = filterLabelsForMetric(name, sanitized);
      counter.inc(errorLabels);
    } else {
      console.warn(`[Prometheus] Unknown error metric: ${name}`);
    }
  },

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    // Silently skip DB-sourced metrics (populated via updateDbMetrics)
    if (dbSourcedMetrics.has(name)) {
      return;
    }
    const gauge = gaugeMap[name];
    if (gauge) {
      gauge.set(sanitizeLabels(labels), value);
    } else {
      console.warn(`[Prometheus] Unknown gauge metric: ${name}`);
    }
  },
};

/**
 * Update hub vote gauges from database stats.
 * Extracted from updateDbMetrics to reduce cognitive complexity.
 */
function updateHubVoteMetrics(voteStats: {
  totalUpvotes: number;
  totalDownvotes: number;
  topWorkflows: { workflowId: string; score: number }[];
  mostClonedWorkflows: { workflowId: string; cloneCount: number }[];
  topVoters: { userId: string; voteCount: number }[];
}): void {
  hubVotesTotal.set({ direction: "upvote" }, voteStats.totalUpvotes);
  hubVotesTotal.set({ direction: "downvote" }, voteStats.totalDownvotes);

  hubWorkflowScore.reset();
  for (const wf of voteStats.topWorkflows) {
    hubWorkflowScore.set({ workflow_id: wf.workflowId }, wf.score);
  }

  hubWorkflowClones.reset();
  for (const wf of voteStats.mostClonedWorkflows) {
    hubWorkflowClones.set({ workflow_id: wf.workflowId }, wf.cloneCount);
  }

  hubUserVotesTotal.reset();
  for (const voter of voteStats.topVoters) {
    hubUserVotesTotal.set({ user_id: voter.userId }, voter.voteCount);
  }
}

// Duration histogram bucket boundaries in milliseconds
const WORKFLOW_DURATION_BUCKETS = [
  100, 250, 500, 1000, 2000, 5000, 10_000, 30_000,
];
const STEP_DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000];

/**
 * Update DB-sourced metrics from database
 *
 * Called before each metrics scrape to ensure fresh data from the database.
 * This is necessary because workflow runner jobs exit before Prometheus can scrape them.
 */
export async function updateDbMetrics(): Promise<void> {
  try {
    // Dynamic import to avoid circular dependencies
    const {
      getWorkflowStatsFromDb,
      getStepStatsFromDb,
      getDailyActiveUsersFromDb,
      getUserStatsFromDb,
      getOrgStatsFromDb,
      getWorkflowDefinitionStatsFromDb,
      getScheduleStatsFromDb,
      getIntegrationStatsFromDb,
      getInfraStatsFromDb,
      getUserListFromDb,
      getOrgListFromDb,
      getVoteStatsFromDb,
    } = await import("../db-metrics");
    const [
      workflowStats,
      stepStats,
      dailyActiveUsers,
      userStats,
      orgStats,
      workflowDefStats,
      scheduleStats,
      integrationStats,
      infraStats,
      userList,
      orgList,
      voteStats,
    ] = await Promise.all([
      getWorkflowStatsFromDb(),
      getStepStatsFromDb(),
      getDailyActiveUsersFromDb(),
      getUserStatsFromDb(),
      getOrgStatsFromDb(),
      getWorkflowDefinitionStatsFromDb(),
      getScheduleStatsFromDb(),
      getIntegrationStatsFromDb(),
      getInfraStatsFromDb(),
      getUserListFromDb(),
      getOrgListFromDb(),
      getVoteStatsFromDb(),
    ]);

    // Update workflow execution counts by status (gauges - point-in-time snapshots)
    workflowExecutionsTotal.set(
      { status: "success" },
      workflowStats.totalSuccess
    );
    workflowExecutionsTotal.set({ status: "error" }, workflowStats.totalError);
    workflowExecutionsTotal.set(
      { status: "running" },
      workflowStats.totalRunning
    );
    workflowExecutionsTotal.set(
      { status: "pending" },
      workflowStats.totalPending
    );
    workflowExecutionsTotal.set(
      { status: "cancelled" },
      workflowStats.totalCancelled
    );

    // Update workflow errors total (convenience gauge for alerting)
    workflowErrorsTotal.set(workflowStats.totalError);

    // Update workflow duration histogram buckets
    for (let i = 0; i < WORKFLOW_DURATION_BUCKETS.length; i++) {
      workflowDurationBucket.set(
        { le: String(WORKFLOW_DURATION_BUCKETS[i]) },
        workflowStats.durationBuckets[i] ?? 0
      );
    }
    // +Inf bucket (all observations)
    workflowDurationBucket.set(
      { le: "+Inf" },
      workflowStats.durationBuckets[WORKFLOW_DURATION_BUCKETS.length] ??
        workflowStats.durationCount
    );

    // Update workflow duration sum and count
    workflowDurationSum.set(workflowStats.durationSum);
    workflowDurationCount.set(workflowStats.durationCount);

    // Update step execution counts by status and type
    // Reset label-based gauges to clear stale step types before repopulating
    stepExecutionsTotal.reset();
    stepErrorsTotal.reset();
    for (const [stepType, counts] of Object.entries(stepStats.countsByType)) {
      stepExecutionsTotal.set(
        { step_type: stepType, status: "success" },
        counts.success
      );
      stepExecutionsTotal.set(
        { step_type: stepType, status: "error" },
        counts.error
      );
      // Update step errors for this type
      stepErrorsTotal.set({ step_type: stepType }, counts.error);
    }

    // Update step duration histogram buckets
    for (let i = 0; i < STEP_DURATION_BUCKETS.length; i++) {
      stepDurationBucket.set(
        { le: String(STEP_DURATION_BUCKETS[i]) },
        stepStats.durationBuckets[i] ?? 0
      );
    }
    // +Inf bucket
    stepDurationBucket.set(
      { le: "+Inf" },
      stepStats.durationBuckets[STEP_DURATION_BUCKETS.length] ??
        stepStats.durationCount
    );

    // Update step duration sum and count
    stepDurationSum.set(stepStats.durationSum);
    stepDurationCount.set(stepStats.durationCount);

    // Update saturation gauges from DB
    workflowQueueDepth.set(workflowStats.totalPending);
    workflowConcurrent.set(workflowStats.totalRunning);
    activeUsers.set(dailyActiveUsers);

    // Update user metrics from DB
    userTotal.set(userStats.total);
    userVerified.set(userStats.verified);
    userAnonymous.set(userStats.anonymous);
    userWithWorkflows.set(userStats.withWorkflows);
    userWithIntegrations.set(userStats.withIntegrations);

    // Update user info gauge (one series per user)
    userInfo.reset();
    for (const user of userList) {
      userInfo.set(
        {
          email: user.email,
          name: user.name,
          verified: String(user.verified),
          created_at: user.createdAt.toISOString(),
        },
        1
      );
    }

    // Update organization metrics from DB
    orgTotal.set(orgStats.total);
    orgMembersTotal.set(orgStats.membersTotal);
    // Reset label-based gauge to clear stale roles before repopulating
    orgMembersByRole.reset();
    for (const [role, count] of Object.entries(orgStats.membersByRole)) {
      orgMembersByRole.set({ role }, count);
    }
    orgInvitationsPending.set(orgStats.invitationsPending);
    orgWithWorkflows.set(orgStats.withWorkflows);

    // Update org info gauge (one series per org)
    orgInfo.reset();
    for (const org of orgList) {
      orgInfo.set({ org_name: org.name, slug: org.slug }, 1);
    }

    // Update workflow definition metrics from DB
    workflowTotal.set(workflowDefStats.total);
    workflowByVisibility.set({ visibility: "public" }, workflowDefStats.public);
    workflowByVisibility.set(
      { visibility: "private" },
      workflowDefStats.private
    );
    workflowAnonymous.set(workflowDefStats.anonymous);

    // Update schedule metrics from DB
    scheduleTotal.set(scheduleStats.total);
    scheduleEnabled.set(scheduleStats.enabled);
    // Reset label-based gauge to clear stale statuses before repopulating
    scheduleByLastStatus.reset();
    for (const [status, count] of Object.entries(scheduleStats.byLastStatus)) {
      scheduleByLastStatus.set({ status }, count);
    }

    // Update integration metrics from DB
    integrationTotal.set(integrationStats.total);
    integrationManaged.set(integrationStats.managed);
    // Reset label-based gauge to clear stale types before repopulating
    integrationByType.reset();
    for (const [type, count] of Object.entries(integrationStats.byType)) {
      integrationByType.set({ type }, count);
    }

    // Update infrastructure metrics from DB
    apiKeyTotal.set(infraStats.apiKeysTotal);
    chainTotal.set(infraStats.chainsTotal);
    chainEnabled.set(infraStats.chainsEnabled);
    paraWalletTotal.set(infraStats.paraWalletsTotal);
    sessionActive.set(infraStats.sessionsActive);

    updateHubVoteMetrics(voteStats);
  } catch (error) {
    console.error("[Prometheus] Failed to update DB metrics:", error);
    // Don't throw - allow other metrics to still be returned
  }
}

/**
 * Get all metrics in Prometheus format (backward compat: /api/metrics)
 */
export async function getPrometheusMetrics(): Promise<string> {
  const merged = Registry.merge([dbRegistry, apiRegistry]);
  return await merged.metrics();
}

/**
 * Get DB-sourced metrics only (/api/metrics/db)
 */
export async function getDbMetrics(): Promise<string> {
  return await dbRegistry.metrics();
}

const initializedChains = new Set<string>();

/**
 * Initialize RPC health gauges for all enabled chains so they appear in
 * Grafana immediately (with healthy/0 defaults) instead of only after
 * first traffic. Each chain is initialized at most once per pod lifetime.
 */
async function initRpcMetricsForAllChains(): Promise<void> {
  if (initializedChains.size > 0) {
    return;
  }

  try {
    const { getEnabledChainNamesFromDb } = await import("../db-metrics");
    const chainNames = await getEnabledChainNamesFromDb();

    for (const chain of chainNames) {
      rpcHealthState.labels({ chain }).inc(0);
      rpcCurrentProvider.labels({ chain }).inc(0);
      // Initialize per-operation counters so both read/write appear in Grafana
      for (const operation of ["read", "write", "preflight"]) {
        rpcPrimaryAttempts.labels({ chain, operation }).inc(0);
        rpcPrimaryFailures.labels({ chain, operation }).inc(0);
      }
      initializedChains.add(chain);
    }
  } catch {
    // Non-fatal: metrics will still populate on first RPC traffic
  }
}

/**
 * Get API-process metrics only (/api/metrics/api)
 */
export async function getApiProcessMetrics(): Promise<string> {
  await initRpcMetricsForAllChains();
  const { startRpcHealthProbe } = await import("../rpc-health-probe");
  startRpcHealthProbe();
  return await apiRegistry.metrics();
}

/**
 * Get content type for Prometheus metrics
 */
export function getPrometheusContentType(): string {
  return dbRegistry.contentType;
}

/**
 * RPC failover metric accessors for the RPC metrics bridge
 */
export const rpcMetrics = {
  primaryAttempts: rpcPrimaryAttempts,
  primaryFailures: rpcPrimaryFailures,
  fallbackAttempts: rpcFallbackAttempts,
  fallbackFailures: rpcFallbackFailures,
  failoverEvents: rpcFailoverEvents,
  recoveryEvents: rpcRecoveryEvents,
  bothFailedEvents: rpcBothFailedEvents,
  currentProvider: rpcCurrentProvider,
  healthState: rpcHealthState,
  latency: rpcLatency,
  errorsByType: rpcErrorsByType,
};

export const rpcProbeMetrics = {
  up: rpcProbeUp,
  latency: rpcProbeLatency,
  errorsTotal: rpcProbeErrorsTotal,
  lastSuccess: rpcProbeLastSuccess,
};
