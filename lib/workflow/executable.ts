import { and, eq, isNull, type SQL } from "drizzle-orm";
import { users, workflows } from "@/lib/db/schema";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

/**
 * The single source of truth for "is this workflow live enough to run". A
 * workflow is executable only when it is enabled, not soft-deleted, and
 * its owner is not deactivated. All five execution entry points (scheduler
 * select, executor dispatch, HTTP execute, webhook, agent-call lookup) must
 * gate on this so they cannot drift apart again.
 *
 * Two shapes are exported because the entry points come in two flavours:
 * - SELECT sites compose `workflowExecutableConditions()` into their WHERE.
 * - fetch-then-gate sites call `getWorkflowExecutability()` on a loaded row.
 * Both encode the same three columns, in one file, so they stay in lockstep.
 *
 * This module must stay free of `@/lib/db` and `server-only` imports: the
 * standalone executor imports it via a relative path and `getWorkflowExecutability`
 * may reach client bundles. Owner deactivation is loaded by each call site with
 * its own db handle, never here.
 */

/**
 * Drizzle WHERE fragment for the SELECT sites. The caller MUST have joined
 * `users` on `workflows.userId` (an inner join is safe - `workflows.userId` is
 * non-null) so the owner clause can resolve.
 */
export function workflowExecutableConditions(): SQL {
  return and(
    eq(workflows.enabled, true),
    workflowNotDeleted(),
    isNull(users.deactivatedAt)
  ) as SQL;
}

export type WorkflowExecutabilityInput = {
  enabled: boolean;
  // `?? null` coercion below treats an absent timestamp as "not set". Mirrors
  // getWorkflowAccess, which fields the same trimmed shapes some callers pass.
  deletedAt?: Date | null;
  ownerDeactivatedAt?: Date | null;
};

export type WorkflowExecutability =
  | { executable: true }
  | { executable: false; reason: "deleted" | "disabled" | "owner_deactivated" };

/**
 * In-memory gate for the fetch-then-gate sites. The reason lets callers map to
 * their existing HTTP semantics (the webhook surfaces "disabled" as 410 and
 * everything else as 404). Precedence is fixed here - deleted beats disabled
 * beats owner-deactivated - because a soft-deleted workflow can still be enabled
 * (`softDeleteValues()` clears `isListed` but not `enabled`), and "gone" is the
 * more accurate signal than "disabled".
 */
export function getWorkflowExecutability(
  workflow: WorkflowExecutabilityInput
): WorkflowExecutability {
  if ((workflow.deletedAt ?? null) !== null) {
    return { executable: false, reason: "deleted" };
  }
  if (!workflow.enabled) {
    return { executable: false, reason: "disabled" };
  }
  if ((workflow.ownerDeactivatedAt ?? null) !== null) {
    return { executable: false, reason: "owner_deactivated" };
  }
  return { executable: true };
}
