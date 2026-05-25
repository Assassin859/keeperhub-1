/**
 * Detection signal for backstop trigger rejects on the executions table.
 *
 * Migration 0082 installed `block_executions_for_inactive_workflows`, a
 * Postgres trigger that raises ERRCODE 42501 ("insufficient_privilege") on
 * INSERT into `workflow_executions` when the owning user is deactivated or
 * the workflow is soft-deleted. A trigger reject means an app-layer guard
 * has been bypassed (bug or attack), so it's the kind of event that should
 * page an on-call, not get buried as a generic 500.
 *
 * The wrapper catches the rejection, emits a structured Sentry event with
 * enough context to triage (which workflow, which user, which entry path),
 * then re-throws so callers preserve their existing error responses. The
 * capture is best-effort -- a Sentry transport failure never blocks the
 * rethrow.
 */

import { captureMessage } from "@sentry/nextjs";
import type { TriggerSource } from "./request-attribution";

const PG_RAISE_INSUFFICIENT_PRIVILEGE = "42501";
const BACKSTOP_MESSAGE_FRAGMENTS = [
  "Workflow owner is deactivated",
  "workflow is soft-deleted",
] as const;

type PgError = { code?: unknown; message?: unknown };

function isBackstopRejection(err: unknown): err is PgError {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as PgError).code;
  if (code !== PG_RAISE_INSUFFICIENT_PRIVILEGE) {
    return false;
  }
  const message = (err as PgError).message;
  if (typeof message !== "string") {
    return false;
  }
  return BACKSTOP_MESSAGE_FRAGMENTS.some((fragment) =>
    message.includes(fragment)
  );
}

export type BackstopRejectContext = {
  workflowId: string;
  userId: string;
  source: TriggerSource;
};

/**
 * Wraps an execution INSERT with backstop-reject detection. If the INSERT
 * raises the ERRCODE 42501 backstop trigger, emit a structured Sentry event
 * before re-throwing. All other errors propagate unchanged.
 */
export async function withBackstopCapture<T>(
  context: BackstopRejectContext,
  insert: () => Promise<T>
): Promise<T> {
  try {
    return await insert();
  } catch (err) {
    if (isBackstopRejection(err)) {
      // Best-effort: never let a Sentry transport failure shadow the
      // original backstop exception. Callers downstream depend on the pg
      // error shape to render correct error responses.
      try {
        captureMessage("security.backstop_execution_blocked", {
          level: "warning",
          tags: {
            security: "backstop_execution_blocked",
            source: context.source,
          },
          user: { id: context.userId },
          extra: {
            workflowId: context.workflowId,
            source: context.source,
          },
        });
      } catch {
        // swallow; capture is observability, not a contract
      }
      // Structured stdout line for Loki / log-only alerting. Independent
      // of Sentry transport so the signal is durable.
      try {
        console.warn(
          JSON.stringify({
            event: "security.backstop_execution_blocked",
            workflowId: context.workflowId,
            userId: context.userId,
            source: context.source,
          })
        );
      } catch {
        // never let log emission shadow the original error
      }
    }
    throw err;
  }
}
