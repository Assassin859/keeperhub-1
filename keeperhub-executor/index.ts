/**
 * Unified Workflow Executor
 *
 * Polls a single SQS queue for all trigger types (schedule, block, event)
 * and executes workflows either in isolated K8s Jobs or in-process,
 * depending on whether the workflow contains web3 write actions.
 *
 * Usage:
 *   tsx keeperhub-executor/index.ts
 *
 * Environment variables:
 *   DATABASE_URL - PostgreSQL connection string
 *   SQS_QUEUE_URL - SQS queue URL (single queue for all trigger types)
 *   AWS_REGION - AWS region (default: us-east-1)
 *   AWS_ENDPOINT_URL - LocalStack endpoint (local dev only)
 *   RUNNER_IMAGE - Docker image for K8s Job workflow runner
 *   K8S_NAMESPACE - Kubernetes namespace for Jobs
 *   INTEGRATION_ENCRYPTION_KEY - Key for decrypting credentials
 *   HEALTH_PORT - Health check server port (default: 3080)
 *   JOB_TTL_SECONDS - Time to keep completed K8s Jobs (default: 3600)
 *   JOB_ACTIVE_DEADLINE - Max Job execution time in seconds (default: 300)
 */

import { createServer, type IncomingMessage } from "node:http";
import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  users,
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "../lib/db/schema";
import { getMetricsCollector } from "../lib/metrics";
import { LabelKeys, MetricNames } from "../lib/metrics/types";
import { withBackstopCapture } from "../lib/security/backstop-capture";
import { buildAttribution } from "../lib/security/request-attribution";
import { generateId } from "../lib/utils/id";
import { checkConcurrencyLimit } from "../lib/workflow/concurrency";
import { getWorkflowExecutability } from "../lib/workflow/executable";
import type { WorkflowNode } from "../lib/workflow/store";
import { type ApiExecuteTriggerType, executeViaApi } from "./api-execute";
import { checkExecutionLimitForExecutor } from "./billing-guard";
import { CONFIG } from "./config";
import { resolveDispatchTarget } from "./execution-mode";
import { checkWorkflowFeaturesForExecutor } from "./feature-guard";
import { executeInProcess } from "./in-process";
import { createWorkflowJob } from "./k8s-job";
import { upgradePhantomToPending } from "./lib/db-helpers";
import { applyCounterDeltas, isIngestPayload } from "./lib/metrics-shipping";
import { toJsonSafe } from "./lib/serialize";
import { assertTurnkeyEnvForActiveWallets } from "./startup-checks";
import type { ExecutorMessage, ScheduleMessage } from "./types";

const INGEST_MAX_BODY_BYTES = 256 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > INGEST_MAX_BODY_BYTES) {
      throw new Error("Ingest payload too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw);
}

// Database
const queryClient = postgres(CONFIG.databaseUrl, {
  connect_timeout: 10,
  idle_timeout: 30,
  max_lifetime: 60 * 5,
  connection: { statement_timeout: 30_000 },
});
const db = drizzle(queryClient, {
  schema: { workflows, workflowExecutions, workflowSchedules },
});

// SQS
const sqsConfig: ConstructorParameters<typeof SQSClient>[0] = {
  region: CONFIG.awsRegion,
};

if (CONFIG.awsEndpoint) {
  sqsConfig.endpoint = CONFIG.awsEndpoint;
  sqsConfig.credentials = {
    accessKeyId: CONFIG.awsAccessKeyId,
    secretAccessKey: CONFIG.awsSecretAccessKey,
  };
}

const sqs = new SQSClient(sqsConfig);

function buildInput(message: ExecutorMessage): Record<string, unknown> {
  switch (message.triggerType) {
    case "schedule":
      return {
        triggerType: "schedule",
        scheduleId: message.scheduleId,
        triggerTime: message.triggerTime,
      };
    case "block":
      return {
        triggerType: "block",
        ...message.triggerData,
      };
    case "event":
      return {
        triggerType: "event",
        ...message.triggerData,
      };
    default: {
      const _exhaustive: never = message;
      throw new Error(
        `Unknown trigger type: ${(_exhaustive as ExecutorMessage).triggerType}`
      );
    }
  }
}

async function validateSchedule(scheduleId: string): Promise<boolean> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    console.error(`[Executor] Schedule not found: ${scheduleId}`);
    return false;
  }

  if (!schedule.enabled) {
    console.log(`[Executor] Schedule disabled, skipping: ${scheduleId}`);
    return false;
  }

  return true;
}

function getScheduleId(message: ExecutorMessage): string | undefined {
  return message.triggerType === "schedule" ? message.scheduleId : undefined;
}

async function dispatchExecution(params: {
  target: string;
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  triggerType: ApiExecuteTriggerType;
  scheduleId?: string;
}): Promise<void> {
  const { target, workflowId, executionId, input, triggerType, scheduleId } =
    params;

  switch (target) {
    case "k8s-job": {
      try {
        const job = await createWorkflowJob({
          workflowId,
          executionId,
          input,
          triggerType,
          scheduleId,
        });

        console.log(
          `[Executor] Created K8s Job: ${job.metadata?.name} for execution ${executionId}`
        );
      } catch (error) {
        console.error("[Executor] Failed to create K8s Job:", error);

        await db
          .update(workflowExecutions)
          .set({
            status: "error",
            error:
              error instanceof Error
                ? `Failed to create job: ${error.message}`
                : "Failed to create job",
            errorCode: "P-0002",
            errorType: "system",
            errorCategory: "infrastructure",
            completedAt: new Date(),
          })
          .where(eq(workflowExecutions.id, executionId));

        throw error;
      }
      break;
    }
    case "api": {
      await executeViaApi({ workflowId, executionId, input, triggerType });
      break;
    }
    case "in-process": {
      await executeInProcess({
        workflowId,
        executionId,
        input,
        scheduleId,
        db,
      });
      break;
    }
    default:
      throw new Error(`Unknown dispatch target: ${target}`);
  }
}

async function processExecutorMessage(message: ExecutorMessage): Promise<void> {
  const { workflowId, triggerType } = message;

  console.log(
    `[Executor] Processing ${triggerType} trigger for workflow ${workflowId}`
  );

  // Load the workflow and its owner's deactivation state in one round-trip.
  const [row] = await db
    .select()
    .from(workflows)
    .leftJoin(users, eq(users.id, workflows.userId))
    .where(eq(workflows.id, workflowId))
    .limit(1);
  const workflow = row?.workflows;

  if (!workflow) {
    console.error(`[Executor] Workflow not found: ${workflowId}`);
    return;
  }

  // A soft-deleted workflow, a disabled workflow, or one whose owner is
  // deactivated must never execute, even if a stale schedule or queued
  // message still references it. The block_executions DB trigger is the
  // INSERT-time backstop; this skips the work before it gets that far.
  const executability = getWorkflowExecutability({
    enabled: workflow.enabled,
    deletedAt: workflow.deletedAt,
    ownerDeactivatedAt: row?.users?.deactivatedAt ?? null,
  });
  if (!executability.executable) {
    console.log(
      `[Executor] Workflow not executable (${executability.reason}), skipping: ${workflowId}`
    );
    return;
  }

  if (triggerType === "schedule") {
    const valid = await validateSchedule(
      (message as ScheduleMessage).scheduleId
    );
    if (!valid) {
      return;
    }
  }

  const billingResult = await checkExecutionLimitForExecutor(
    db,
    workflow.organizationId
  );
  if (!billingResult.allowed) {
    console.warn(
      `[Executor] Billing guard blocked ${triggerType} trigger for workflow ${workflowId}: org=${workflow.organizationId} plan=${billingResult.plan} used=${billingResult.used} limit=${billingResult.limit} effectiveLimit=${billingResult.effectiveLimit} debt=${billingResult.debtExecutions} reason=${billingResult.reason}`
    );
    return;
  }

  const featureResult = await checkWorkflowFeaturesForExecutor(
    db,
    workflow.organizationId,
    workflow.nodes as unknown[]
  );
  if (!featureResult.allowed) {
    const gatedFeatureIds = featureResult.violations
      .map((v) => v.featureId)
      .join(",");
    const errorMessage = `Workflow uses features that require a paid plan: ${featureResult.violations
      .map((v) => v.feature.name)
      .join(", ")}`;
    console.warn(
      `[Executor] Feature guard blocked ${triggerType} trigger for workflow ${workflowId}: org=${workflow.organizationId} gated=${gatedFeatureIds}`
    );
    // Record a failed execution row so the user sees this in their dashboard
    // instead of the trigger silently vanishing. Matches the shape of a regular
    // step failure (status=error, completedAt set) so the rest of the UI
    // and metrics pipeline pick it up uniformly.
    const blockedInput = buildInput(message);
    const blockedUserId =
      "userId" in message ? message.userId : workflow.userId;

    // KEEP-693: if a phantom row was pre-created for this trigger, resolve it
    // in place to the blocked (billing/user) state rather than inserting a
    // second row -- and so the reaper does not later age the orphaned phantom
    // to a system P-code. Falls through to an insert when there is no phantom.
    let blockedResolved = false;
    if (message.executionId) {
      const resolved = await db
        .update(workflowExecutions)
        .set({
          status: "error",
          error: errorMessage,
          errorCategory: "billing",
          errorType: "user",
          input: toJsonSafe(blockedInput) as Record<string, unknown>,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(workflowExecutions.id, message.executionId),
            eq(workflowExecutions.status, "phantom")
          )
        )
        .returning({ id: workflowExecutions.id });
      blockedResolved = resolved.length > 0;
    }

    if (!blockedResolved) {
      const blockedExecutionId = generateId();
      // KEEP-612: attribute the source so blocked scheduled/block/event rows
      // are not NULL in the audit columns. No client request here (SQS
      // dispatch), so ip/country/key are correctly left null.
      const blockedAttribution = buildAttribution({ source: triggerType });
      await withBackstopCapture(
        { workflowId, userId: blockedUserId, source: triggerType },
        () =>
          db.insert(workflowExecutions).values({
            id: blockedExecutionId,
            workflowId,
            userId: blockedUserId,
            status: "error",
            input: toJsonSafe(blockedInput) as Record<string, unknown>,
            error: errorMessage,
            errorCategory: "billing",
            errorType: "user",
            startedAt: new Date(),
            completedAt: new Date(),
            ...blockedAttribution,
          })
      );
    }
    return;
  }

  // Concurrency back-pressure: enforce the same running-execution cap the API
  // routes apply, regardless of dispatch target. Throw rather than drop so the
  // SQS message is redelivered after the visibility timeout once capacity frees,
  // and do it before creating the row so a requeue does not leave orphans.
  const concurrency = await checkConcurrencyLimit(db);
  if (!concurrency.allowed) {
    throw new Error(
      `Concurrency limit reached (${concurrency.running}/${concurrency.limit}); requeueing workflow ${workflowId}`
    );
  }

  const input = buildInput(message);
  const userId = "userId" in message ? message.userId : workflow.userId;
  const serializedInput = toJsonSafe(input) as Record<string, unknown>;

  // KEEP-693: unified phantom row. The scheduler/event-tracker pre-creates a
  // 'phantom' row and passes its id on the message; upgrade it to 'pending' in
  // place (CAS on status='phantom'). The generated id is the fallback for when
  // there is no phantom to upgrade -- a legacy message with no id, or a phantom
  // that is missing (best-effort create failed) or already advanced (a
  // duplicate SQS delivery won the upgrade) -- so a run is never dropped.
  let executionId = generateId();
  let upgraded = false;
  if (message.executionId) {
    upgraded = await upgradePhantomToPending(
      db,
      message.executionId,
      serializedInput
    );
    if (upgraded) {
      executionId = message.executionId;
    }
  }

  if (!upgraded) {
    // KEEP-612: insert for SQS-dispatched runs with no phantom to upgrade.
    // Downstream dispatch (executeViaApi / k8s) reuses this row, so the
    // app-route attribution never runs here -- set it directly. Only
    // trigger_source applies: SQS dispatch has no inbound client request, so
    // ip/country/api-key stay null. withBackstopCapture emits
    // security.backstop_execution_blocked if the 0082 trigger rejects (e.g.
    // owner deactivated in the check->insert race).
    const attribution = buildAttribution({ source: triggerType });
    await withBackstopCapture({ workflowId, userId, source: triggerType }, () =>
      db.insert(workflowExecutions).values({
        id: executionId,
        workflowId,
        userId,
        status: "pending",
        input: serializedInput,
        ...attribution,
      })
    );
  }

  console.log(`[Executor] Created execution record: ${executionId}`);

  // Counter for the "zero executions in N min" alert family (KEEP-556).
  // Increments here for every SQS-triggered run regardless of dispatch target
  // (k8s-job / in-process / api). The route.ts handler only increments when it
  // creates the row itself - so manual and webhook flows go through there, and
  // schedule / block / event go through here, with no double-count when the
  // executor hands off via process mode and the API uses our pre-existing row.
  getMetricsCollector().incrementCounter(
    MetricNames.WORKFLOW_EXECUTIONS_STARTED_TOTAL,
    {
      [LabelKeys.TRIGGER_TYPE]: triggerType,
      [LabelKeys.CHAIN]: workflow.chain ?? "_unknown",
    }
  );

  const nodes = workflow.nodes as WorkflowNode[];
  const target = resolveDispatchTarget(nodes);
  console.log(
    `[Executor] Dispatch target: ${target} (mode: ${CONFIG.executionMode})`
  );

  try {
    await dispatchExecution({
      target,
      workflowId,
      executionId,
      input,
      triggerType,
      scheduleId: getScheduleId(message),
    });
  } catch (error) {
    // Don't leak the inserted row as 'pending' if dispatch fails. The
    // k8s-job target updates the row internally; this outer guard covers
    // api / in-process / future targets uniformly. The status='pending'
    // filter prevents overwriting a status the runtime already set if
    // the failure happened after the workflow started running.
    await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error:
          error instanceof Error
            ? `Dispatch failed: ${error.message}`
            : "Dispatch failed",
        errorCode: "P-0004",
        errorType: "system",
        errorCategory: "infrastructure",
        completedAt: new Date(),
      })
      .where(
        and(
          eq(workflowExecutions.id, executionId),
          eq(workflowExecutions.status, "pending")
        )
      );
    throw error;
  }
}

async function processMessage(message: Message): Promise<void> {
  if (!(message.Body && message.ReceiptHandle)) {
    console.error("[Executor] Invalid message:", message);
    return;
  }

  let body: ExecutorMessage;
  try {
    body = JSON.parse(message.Body);
  } catch {
    console.error("[Executor] Malformed message body, deleting:", message.Body);
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: CONFIG.sqsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      })
    );
    return;
  }

  try {
    await processExecutorMessage(body);

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: CONFIG.sqsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      })
    );

    console.log(`[Executor] Message deleted for workflow ${body.workflowId}`);
  } catch (error) {
    console.error(
      `[Executor] Failed to process workflow ${body.workflowId}:`,
      error
    );
  }
}

async function listen(): Promise<void> {
  console.log("[Executor] Starting unified workflow executor...");
  console.log(`[Executor] Execution mode: ${CONFIG.executionMode}`);
  console.log(`[Executor] Queue URL: ${CONFIG.sqsQueueUrl}`);
  console.log(`[Executor] Runner image: ${CONFIG.runnerImage}`);
  console.log(`[Executor] K8s namespace: ${CONFIG.namespace}`);

  // Wire up Prometheus dual-write. The Next.js app does this in
  // instrumentation.ts; the executor is a separate tsx-launched process and
  // never runs Next.js's instrumentation hook, so without this its
  // getMetricsCollector() calls would only hit the console collector and the
  // executor's /metrics endpoint would never see the counter series. See
  // KEEP-556 for the missing-counter symptom this fixes.
  if (process.env.METRICS_COLLECTOR === "prometheus") {
    const { prometheusMetricsCollector } = await import(
      "../lib/metrics/collectors/prometheus"
    );
    const { createDualWriteCollector } = await import(
      "../lib/metrics/collectors/dual"
    );
    const { setMetricsCollector } = await import("../lib/metrics");
    setMetricsCollector(createDualWriteCollector(prometheusMetricsCollector));
    console.log(
      "[Executor] Prometheus dual-write metrics collector initialized"
    );
  }

  await assertTurnkeyEnvForActiveWallets(db);

  // Health check + metrics server
  const healthServer = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "keeperhub-executor",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (req.url === "/metrics" && req.method === "GET") {
      if (process.env.METRICS_COLLECTOR !== "prometheus") {
        res.writeHead(404);
        res.end();
        return;
      }
      (async (): Promise<void> => {
        try {
          const { getApiProcessMetrics, getPrometheusContentType } =
            await import("../lib/metrics/prometheus-api");
          const metrics = await getApiProcessMetrics();
          res.writeHead(200, {
            "Content-Type": getPrometheusContentType(),
            "Cache-Control": "no-store, no-cache, must-revalidate",
          });
          res.end(metrics);
        } catch (error) {
          console.error("[Executor] Failed to serve metrics:", error);
          res.writeHead(500);
          res.end("Failed to collect metrics");
        }
      })();
      return;
    }

    if (req.url === "/metrics/ingest" && req.method === "POST") {
      if (process.env.METRICS_COLLECTOR !== "prometheus") {
        res.writeHead(404);
        res.end();
        return;
      }
      const expectedToken = process.env.METRICS_INGEST_TOKEN;
      if (!expectedToken) {
        res.writeHead(503);
        res.end("Ingest not configured");
        return;
      }
      if (req.headers["x-ingest-token"] !== expectedToken) {
        res.writeHead(401);
        res.end();
        return;
      }
      (async (): Promise<void> => {
        try {
          const body = await readJsonBody(req);
          if (!isIngestPayload(body)) {
            res.writeHead(400);
            res.end("Invalid ingest payload");
            return;
          }
          const { applied, skipped } = await applyCounterDeltas(body.deltas);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ applied, skipped }));
        } catch (error) {
          console.error("[Executor] Metrics ingest failed:", error);
          res.writeHead(500);
          res.end("Ingest failed");
        }
      })();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  healthServer.listen(CONFIG.healthPort, () => {
    console.log(
      `[Executor] Health check server listening on port ${CONFIG.healthPort}`
    );
  });

  const shutdown = async (): Promise<void> => {
    console.log("\n[Executor] Shutting down...");
    healthServer.close();
    await queryClient.end();
    console.log("[Executor] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // SQS polling loop
  while (true) {
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: CONFIG.sqsQueueUrl,
          MaxNumberOfMessages: CONFIG.maxMessages,
          WaitTimeSeconds: CONFIG.waitTimeSeconds,
          VisibilityTimeout: CONFIG.visibilityTimeout,
          MessageAttributeNames: ["All"],
        })
      );

      const messages = response.Messages || [];

      if (messages.length > 0) {
        console.log(`[Executor] Received ${messages.length} messages`);

        const results = await Promise.allSettled(
          messages.map((msg) => processMessage(msg))
        );

        for (const [idx, result] of results.entries()) {
          if (result.status === "rejected") {
            console.error(`[Executor] Message ${idx} failed:`, result.reason);
          }
        }
      }
    } catch (error) {
      console.error("[Executor] Error receiving messages:", error);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

listen().catch((error: unknown) => {
  console.error("[Executor] Fatal startup error:", error);
  process.exit(1);
});
