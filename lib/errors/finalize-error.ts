import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, workflows } from "@/lib/db/schema";
import { classifyExecutionError } from "@/lib/errors/classify";
import type { ErrorStatus } from "@/lib/errors/execution-status";
import {
  recordWorkflowExecutionError,
  recordWorkflowExecutionErrorByWorkflow,
  recordWorkflowExecutionFinished,
} from "@/lib/metrics/collectors/prometheus";
import { ANONYMOUS_ORG_SLUG } from "@/lib/metrics/db-metrics";

/**
 * Increment `keeperhub_workflow_execution_errors_created_total` after a
 * `workflow_executions` row has been written with a terminal error status.
 *
 * Resolves the org slug for the workflow so the counter series is scoped
 * for the SLA alert (Sky/Ajna). Falls back to ANONYMOUS_ORG_SLUG for
 * personal workflows so personal failures still emit a series.
 *
 * `persistedStatus` must be the status the caller actually wrote to the row.
 * The finished counter's status label has to match the DB (and the engine
 * path, which applies the isDefaultClassification carve-out before writing),
 * so it cannot be re-derived here from the classified error type alone.
 *
 * Safe to call after the DB write succeeded. Errors are caught and dropped
 * because metric emission must never break an already-finalized execution.
 */
export async function recordExecutionErrorFinalized(args: {
  workflowId: string;
  errorMessage: string | null | undefined;
  persistedStatus: ErrorStatus;
  errorCategory?: string;
}): Promise<void> {
  try {
    const classification = classifyExecutionError(args.errorMessage);
    const errorCategory = args.errorCategory ?? classification.errorCategory;
    const { errorType } = classification;

    const row = await db
      .select({ slug: organization.slug })
      .from(workflows)
      .leftJoin(organization, eq(workflows.organizationId, organization.id))
      .where(eq(workflows.id, args.workflowId))
      .limit(1);

    const orgSlug = row[0]?.slug ?? ANONYMOUS_ORG_SLUG;

    recordWorkflowExecutionError({
      orgSlug,
      errorCategory,
      errorType,
    });

    recordWorkflowExecutionErrorByWorkflow({
      workflowId: args.workflowId,
      orgSlug,
      errorType,
    });

    recordWorkflowExecutionFinished({
      status: args.persistedStatus,
      orgSlug,
      errorType,
    });
  } catch {
    // Counter emission must not break the execution finalize path.
  }
}
