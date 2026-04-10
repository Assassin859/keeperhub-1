import { workflows } from "@/lib/db/schema";

/**
 * Exact columns the call route needs from the workflows table.
 * priceUsdcPerCall returns string | null from Drizzle (numeric column).
 * nodes and edges are needed for execution; userId for creating the execution record.
 */
export type CallRouteWorkflow = {
  id: string;
  name: string;
  description: string | null;
  organizationId: string | null;
  listedSlug: string | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  isListed: boolean;
  workflowType: "read" | "write";
  nodes: unknown[];
  edges: unknown[];
  userId: string;
};

/**
 * Column projection for the call route DB query.
 * Mirrors the LISTED_WORKFLOW_COLUMNS pattern from app/api/mcp/workflows/route.ts
 * but includes the execution-required columns: nodes, edges, userId.
 */
export const CALL_ROUTE_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  organizationId: workflows.organizationId,
  listedSlug: workflows.listedSlug,
  inputSchema: workflows.inputSchema,
  outputMapping: workflows.outputMapping,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  isListed: workflows.isListed,
  workflowType: workflows.workflowType,
  nodes: workflows.nodes,
  edges: workflows.edges,
  userId: workflows.userId,
} as const;
