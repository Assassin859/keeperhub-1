import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { organization, workflows } from "../../lib/db/schema";
import { classifyExecutionError } from "../../lib/errors/classify";
import type { ErrorStatus } from "../../lib/errors/execution-status";
import {
  recordWorkflowExecutionError,
  recordWorkflowExecutionErrorByWorkflow,
  recordWorkflowExecutionFinished,
} from "../../lib/metrics/collectors/prometheus";
import { NA_ERROR_TYPE } from "../../lib/metrics/metric-constants";
import { resolveOrgSlugCached } from "../../lib/metrics/org-slug-cache";
import type { DbSchema } from "./db-helpers";

/**
 * Emit the terminal workflow counters for an executor-side terminal write
 * (consumer-crash backstop, billing block, engine-write-lost backstop).
 * These writes happen outside logWorkflowCompleteDb/recordExecutionErrorFinalized,
 * so without this the executions they finalize are invisible to the
 * success-rate SLI. Callers must only invoke it when their compare-and-set
 * actually flipped a non-terminal row, which preserves the emit-once
 * contract. Never throws: metric emission must not break executor DB writes.
 */
export async function recordTerminalSample(
  db: PostgresJsDatabase<DbSchema>,
  args: {
    workflowId: string;
    status: "success" | ErrorStatus;
    errorMessage?: string | null;
    errorType?: "user" | "system";
    errorCategory?: string;
  }
): Promise<void> {
  try {
    const orgSlug = await resolveOrgSlugCached(args.workflowId, (id) =>
      db
        .select({ slug: organization.slug })
        .from(workflows)
        .leftJoin(organization, eq(workflows.organizationId, organization.id))
        .where(eq(workflows.id, id))
        .limit(1)
    );

    if (args.status === "success") {
      recordWorkflowExecutionFinished({
        status: "success",
        orgSlug,
        errorType: NA_ERROR_TYPE,
      });
      return;
    }

    const classification = classifyExecutionError(args.errorMessage);
    const errorType = args.errorType ?? classification.errorType;
    const errorCategory = args.errorCategory ?? classification.errorCategory;

    recordWorkflowExecutionError({ orgSlug, errorCategory, errorType });
    recordWorkflowExecutionErrorByWorkflow({
      workflowId: args.workflowId,
      orgSlug,
      errorType,
    });
    recordWorkflowExecutionFinished({
      status: args.status,
      orgSlug,
      errorType,
    });
  } catch {
    // Counter emission must never break the executor's terminal writes.
  }
}
