import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { withBackstopCapture } from "@/lib/security/backstop-capture";
import {
  buildAttribution,
  type TriggerSource,
} from "@/lib/security/request-attribution";

const VALID_TRIGGER_SOURCES: readonly TriggerSource[] = [
  "manual",
  "webhook",
  "scheduled",
  "schedule",
  "mcp",
  "internal",
  "block",
  "event",
];

/**
 * Resolve a caller-supplied trigger source to a known value, defaulting to
 * "internal" for unknown/absent input. Schedulers pass "schedule" | "block" |
 * "event" when pre-creating a phantom so the audit column reflects the real
 * entry point rather than the generic internal-API path.
 */
function resolveTriggerSource(value: unknown): TriggerSource {
  if (typeof value === "string") {
    const match = VALID_TRIGGER_SOURCES.find((source) => source === value);
    if (match) {
      return match;
    }
  }
  return "internal";
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const auth = await authenticateInternalService(request, rawBody);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const body = JSON.parse(rawBody);
  const { workflowId, userId, input, status, triggerSource } = body;

  // A phantom row represents an expected-but-unstarted trigger that the
  // scheduler/event-tracker pre-creates; the executor later upgrades it to
  // running. Any other status keeps the existing direct-execution behaviour of
  // creating a row already marked running.
  const isPhantom = status === "phantom";

  if (!(workflowId && userId)) {
    return NextResponse.json(
      { error: "workflowId and userId are required" },
      { status: 400 }
    );
  }

  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, workflowId),
    columns: {
      organizationId: true,
      deletedAt: true,
      nodes: true,
    },
  });

  // KEEP-440: never create an execution for a soft-deleted workflow.
  if (!workflow || workflow.deletedAt) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }

  const featureGuard = await enforceWorkflowFeatures(
    extractActionTypeNodes(workflow.nodes as unknown[]),
    workflow.organizationId
  );
  if (featureGuard.blocked) {
    return featureGuard.response;
  }

  // Phantom rows do not consume execution quota at creation time -- the limit
  // is enforced when the executor upgrades the row to running. A real (running)
  // row enforces it up front as before.
  if (!isPhantom) {
    const executionGuard = await enforceExecutionLimit(workflow.organizationId);
    if (executionGuard.blocked) {
      return executionGuard.response;
    }
  }

  const source = resolveTriggerSource(triggerSource);
  const attribution = buildAttribution({ request, source });

  const [execution] = await withBackstopCapture(
    { workflowId, userId, source },
    () =>
      db
        .insert(workflowExecutions)
        .values({
          workflowId,
          userId,
          status: isPhantom ? "phantom" : "running",
          input: input || {},
          ...attribution,
        })
        .returning({ id: workflowExecutions.id })
  );

  return NextResponse.json({ executionId: execution.id }, { status: 201 });
}
