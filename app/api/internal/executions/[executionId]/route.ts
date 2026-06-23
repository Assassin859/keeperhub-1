import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { type ErrorCode, getErrorCodeEntry } from "@/lib/errors/error-codes";
import { isErrorStatus } from "@/lib/errors/execution-status";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory } from "@/lib/logging";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  const rawBody = await request.text();
  const auth = await authenticateInternalService(request, rawBody);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const { executionId } = await context.params;
  const body = JSON.parse(rawBody);
  const { status, error, duration, errorCode } = body;

  type ExecutionStatus = "running" | "success" | "error" | "system_error";
  const validStatuses: ExecutionStatus[] = [
    "running",
    "success",
    "error",
    "system_error",
  ];

  // Validate status
  if (!(status && validStatuses.includes(status))) {
    return NextResponse.json(
      {
        error:
          "status must be 'running', 'success', 'error', or 'system_error'",
      },
      { status: 400 }
    );
  }

  // Optional system error code (PREFIX-NNNN). When present it must be a known
  // registry code; the matching category/type are derived from it so the row
  // stays consistent with classifier-written error rows.
  let codeEntry: ReturnType<typeof getErrorCodeEntry> = null;
  if (errorCode !== undefined && errorCode !== null) {
    codeEntry = getErrorCodeEntry(errorCode);
    if (!codeEntry) {
      return NextResponse.json({ error: "Invalid errorCode" }, { status: 400 });
    }
  }

  const typedStatus = status as ExecutionStatus;

  // Check execution exists and is not already cancelled
  const existing = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
    columns: { id: true, status: true },
  });

  if (!existing) {
    return NextResponse.json({ error: "Execution not found" }, { status: 404 });
  }

  // Don't overwrite cancelled status (user already stopped this execution)
  if (existing.status === "cancelled") {
    return NextResponse.json({ success: true });
  }

  // Build update payload
  const isError = isErrorStatus(status);
  const isTerminal = status === "success" || isError;
  const updateData: {
    status: ExecutionStatus;
    error?: string | null;
    errorCode?: ErrorCode;
    errorType?: "system";
    errorCategory?: ErrorCategory;
    completedAt?: Date;
    duration?: string;
    currentNodeId?: null;
    currentNodeName?: null;
  } = { status: typedStatus };

  if (isError) {
    updateData.error = error || "Unknown error";
    updateData.completedAt = new Date();
    if (codeEntry) {
      updateData.errorCode = codeEntry.code;
      updateData.errorType = "system";
      updateData.errorCategory = codeEntry.category;
    } else if (status === "system_error") {
      // A system_error row must carry the system classification even when the
      // caller did not supply a registry code, so downstream readers that
      // assume status='system_error' implies errorType='system' stay consistent.
      updateData.errorType = "system";
      updateData.errorCategory = ErrorCategory.INFRASTRUCTURE;
    }
  } else if (status === "success") {
    updateData.completedAt = new Date();
  }

  if (isTerminal) {
    updateData.currentNodeId = null;
    updateData.currentNodeName = null;
    if (typeof duration === "string") {
      updateData.duration = duration;
    }
  }

  await db
    .update(workflowExecutions)
    .set(updateData)
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        ne(workflowExecutions.status, "cancelled")
      )
    );

  return NextResponse.json({ success: true });
}
