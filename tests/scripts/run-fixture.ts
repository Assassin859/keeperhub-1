/**
 * Live workflow fixture runner.
 *
 * Loads a workflow fixture JSON, POSTs to a target deploy's
 * /api/workflows/create, triggers /api/workflow/{id}/execute, polls until
 * the run terminates, prints the per-step trace and final output.
 *
 * Usage:
 *   FIXTURE=tests/integration/fixtures/superfluid-workflows/get-net-flow.json \
 *   ORIGIN=https://app-pr-1114.keeperhub.com \
 *   COOKIE='CF_Authorization=...; __Secure-better-auth.session_token=...' \
 *   pnpm tsx tests/scripts/run-fixture.ts
 *
 * Required env:
 *   FIXTURE   path to a workflow JSON (relative to repo root or absolute)
 *   ORIGIN    full deploy origin (https://app-pr-N.keeperhub.com)
 *   COOKIE    cookie header value carrying CF Access JWT and the better-auth
 *             session. Easiest to copy from a logged-in browser DevTools
 *             "Copy as cURL" against any /api/ request.
 *
 * Optional env:
 *   POLL_INTERVAL_MS  default 4000
 *   TIMEOUT_MS        default 300000 (5 min)
 *   INTEGRATION_ID    if set, replaces every node's data.config.integrationId
 *                     before POST. Use when re-running a fixture against a
 *                     different deploy/user (the captured ID is per-org).
 *
 * Why cookies and not just an API key: PR hosts sit behind Cloudflare
 * Access. The kh CLI's API-key path bypasses better-auth but NOT CF
 * Access, so /api/* returns the SSO HTML. Browser cookies carry both
 * tokens. For long-running automation, use a CF Access service token
 * instead and switch this script to header-based auth.
 */

import fs from "node:fs";
import path from "node:path";

type ExecResponse = { executionId: string; status: string };

type Execution = {
  id: string;
  status: "running" | "success" | "error" | string;
  output: Record<string, unknown> | null;
  error: string | null;
  duration: string | null;
  completedSteps: string | null;
};

type StepTrace = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: "success" | "error" | "running" | string;
  durationMs: number | null;
  error: string | null;
};

type WorkflowNodeDoc = {
  id: string;
  type: string;
  data: { config?: Record<string, unknown> };
};

type WorkflowDoc = {
  name: string;
  description?: string;
  nodes: WorkflowNodeDoc[];
  edges: unknown[];
};

const FIXTURE = requireEnv("FIXTURE");
const ORIGIN = requireEnv("ORIGIN");
const COOKIE = requireEnv("COOKIE");
const POLL_INTERVAL_MS = Number.parseInt(
  process.env.POLL_INTERVAL_MS ?? "4000",
  10
);
const TIMEOUT_MS = Number.parseInt(process.env.TIMEOUT_MS ?? "300000", 10);
const INTEGRATION_ID_OVERRIDE = process.env.INTEGRATION_ID;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function loadFixture(p: string): WorkflowDoc {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const raw = fs.readFileSync(abs, "utf-8");
  const doc = JSON.parse(raw) as WorkflowDoc;
  if (INTEGRATION_ID_OVERRIDE) {
    for (const node of doc.nodes) {
      if (node.data?.config && "integrationId" in node.data.config) {
        node.data.config.integrationId = INTEGRATION_ID_OVERRIDE;
      }
    }
  }
  return doc;
}

function api(p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", COOKIE);
  headers.set("origin", ORIGIN);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${ORIGIN}${p}`, { ...init, headers });
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Non-JSON response (likely Cloudflare Access HTML). First 500 chars: ${text.slice(
        0,
        500
      )}`
    );
  }
}

async function createWorkflow(doc: WorkflowDoc): Promise<string> {
  const res = await api("/api/workflows/create", {
    method: "POST",
    body: JSON.stringify(doc),
  });
  const created = await readJson<{ id: string; name: string }>(res);
  return created.id;
}

async function executeWorkflow(workflowId: string): Promise<string> {
  const res = await api(`/api/workflow/${workflowId}/execute`, {
    method: "POST",
    body: "{}",
  });
  const exec = await readJson<ExecResponse>(res);
  return exec.executionId;
}

async function pollExecution(workflowId: string): Promise<Execution> {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const res = await api(`/api/workflows/${workflowId}/executions`);
    const list = await readJson<Execution[]>(res);
    const latest = list[0];
    if (!latest) {
      throw new Error("No execution found for workflow");
    }
    if (latest.status !== "running") {
      return latest;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${TIMEOUT_MS}ms`);
}

async function fetchSteps(executionId: string): Promise<StepTrace[]> {
  const res = await api(`/api/analytics/runs/${executionId}/steps`);
  return readJson<StepTrace[]>(res);
}

async function main(): Promise<void> {
  const doc = loadFixture(FIXTURE);
  console.log(`Fixture: ${FIXTURE}`);
  console.log(`Workflow: ${doc.name}`);

  const workflowId = await createWorkflow(doc);
  console.log(`Created workflow: ${workflowId}`);

  const executionId = await executeWorkflow(workflowId);
  console.log(`Execution started: ${executionId}`);

  const final = await pollExecution(workflowId);
  console.log(
    `\nFinal status: ${final.status} (duration ${final.duration ?? "?"}ms, ` +
      `${final.completedSteps ?? "?"} steps completed)`
  );

  const steps = await fetchSteps(executionId);
  console.log("\nPer-step trace:");
  for (const s of steps) {
    console.log(
      `  [${s.status.padEnd(7)}] ${s.nodeName} (${s.nodeType})` +
        ` - ${s.durationMs ?? "?"}ms` +
        (s.error ? `\n    error: ${s.error}` : "")
    );
  }

  if (final.output) {
    console.log("\nOutput:");
    console.log(JSON.stringify(final.output, null, 2));
  }

  if (final.error) {
    console.log(`\nError: ${final.error}`);
    process.exit(2);
  }
  if (final.status !== "success") {
    process.exit(2);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
