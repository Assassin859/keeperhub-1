import "server-only";

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs } from "@/lib/db/schema";

export async function fetchCompletedStepOutputStep(
  executionId: string,
  nodeId: string
): Promise<{ outputRaw: unknown } | null> {
  "use step";

  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    return tx.query.workflowExecutionLogs.findFirst({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflowExecutionLogs.nodeId, nodeId),
        eq(workflowExecutionLogs.status, "success"),
        isNull(workflowExecutionLogs.iterationIndex),
        isNull(workflowExecutionLogs.forEachNodeId),
        isNotNull(workflowExecutionLogs.outputRaw)
      ),
      orderBy: desc(workflowExecutionLogs.completedAt),
      columns: { outputRaw: true },
    });
  });

  if (!row) {
    return null;
  }

  return { outputRaw: row.outputRaw as unknown };
}

fetchCompletedStepOutputStep.maxRetries = 1;

export async function fetchCompletedStepOutputsBatchStep(
  executionId: string,
  nodeIds: string[]
): Promise<Array<{ nodeId: string; outputRaw: unknown }>> {
  "use step";

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    return tx.query.workflowExecutionLogs.findMany({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        inArray(workflowExecutionLogs.nodeId, nodeIds),
        eq(workflowExecutionLogs.status, "success"),
        isNull(workflowExecutionLogs.iterationIndex),
        isNull(workflowExecutionLogs.forEachNodeId),
        isNotNull(workflowExecutionLogs.outputRaw)
      ),
      orderBy: desc(workflowExecutionLogs.completedAt),
      columns: { nodeId: true, outputRaw: true },
    });
  });

  return rows.map((row) => ({
    nodeId: row.nodeId,
    outputRaw: row.outputRaw as unknown,
  }));
}

fetchCompletedStepOutputsBatchStep.maxRetries = 1;
