import { isNull, type SQL } from "drizzle-orm";
import { workflows } from "@/lib/db/schema";

/**
 * KEEP-440: Drizzle predicate that excludes soft-deleted workflow rows.
 *
 * Workflows are soft-deleted (`deletedAt` set) instead of hard-deleted so the
 * listed slug stays bound to the row and cannot be re-claimed by another
 * workflow. Every read that should treat a deleted workflow as gone must
 * compose this into its WHERE clause. The owner-facing workflow list is the
 * deliberate exception -- it keeps showing deleted rows so the UI can mark
 * them as deleted.
 */
export function workflowNotDeleted(): SQL {
  return isNull(workflows.deletedAt);
}

/** KEEP-440: true when a fetched workflow row has been soft-deleted. */
export function isWorkflowDeleted(workflow: {
  deletedAt: Date | null;
}): boolean {
  return workflow.deletedAt !== null;
}
