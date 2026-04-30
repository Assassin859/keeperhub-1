import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { findFirstWriteActionNode } from "@/lib/mcp/calldata";

export type ListingErrorCode =
  | "NOT_FOUND"
  | "SLUG_CONFLICT"
  | "PRICE_CHANGE_WHILE_LISTED"
  | "INVALID_INPUT"
  | "MISSING_WRITE_ACTION";

export type ListingResult<T> =
  | { ok: true; listing: T }
  | { ok: false; error: ListingErrorCode };

export interface ListWorkflowMetadata {
  slug?: string;
  category?: string;
  chain?: string;
  inputSchema?: Record<string, unknown>;
  outputMapping?: Record<string, unknown>;
  workflowType?: string;
}

export interface UpdateWorkflowPatch {
  category?: string;
  chain?: string;
  inputSchema?: Record<string, unknown>;
  outputMapping?: Record<string, unknown>;
  workflowType?: string;
  priceUsdcPerCall?: string;
}

const LISTING_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  listedSlug: workflows.listedSlug,
  listedAt: workflows.listedAt,
  inputSchema: workflows.inputSchema,
  outputMapping: workflows.outputMapping,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  organizationId: workflows.organizationId,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
  isListed: workflows.isListed,
  workflowType: workflows.workflowType,
  category: workflows.category,
  chain: workflows.chain,
};

type ListingRow = {
  id: string;
  name: string;
  description: string | null;
  listedSlug: string | null;
  listedAt: Date | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  organizationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  isListed: boolean;
  workflowType: "read" | "write";
  category: string | null;
  chain: string | null;
};

function isSlugConflict(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code === "23505";
}

export async function listWorkflow(
  workflowId: string,
  orgId: string,
  metadata: ListWorkflowMetadata = {}
): Promise<ListingResult<typeof workflows.$inferSelect>> {
  const existing = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)))
    .limit(1);

  if (existing.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const current = existing[0];

  const updateSet: Partial<typeof workflows.$inferInsert> & {
    updatedAt: Date;
    listedAt: Date;
    isListed: boolean;
  } = {
    isListed: true,
    listedAt: new Date(),
    updatedAt: new Date(),
  };

  if (current.listedSlug === null) {
    if (!metadata.slug) {
      return { ok: false, error: "INVALID_INPUT" };
    }
    updateSet.listedSlug = metadata.slug;
  }
  // If listedSlug is already set, do not overwrite it (slug is sticky)

  if (metadata.category !== undefined) {
    updateSet.category = metadata.category;
  }
  if (metadata.chain !== undefined) {
    updateSet.chain = metadata.chain;
  }
  if (metadata.inputSchema !== undefined) {
    updateSet.inputSchema = metadata.inputSchema;
  }
  if (metadata.outputMapping !== undefined) {
    updateSet.outputMapping = metadata.outputMapping;
  }
  if (metadata.workflowType !== undefined) {
    updateSet.workflowType = metadata.workflowType as "read" | "write";
  }

  // A write workflow must contain at least one node whose actionType matches
  // the calldata matcher; otherwise call_workflow would later fail at runtime
  // with "No write action node found in workflow". Reject at publish time so
  // the listing can never reach search results in a broken state.
  const resolvedWorkflowType: "read" | "write" =
    (updateSet.workflowType as "read" | "write" | undefined) ??
    current.workflowType;
  if (
    resolvedWorkflowType === "write" &&
    findFirstWriteActionNode(current.nodes) === undefined
  ) {
    return { ok: false, error: "MISSING_WRITE_ACTION" };
  }

  try {
    const [result] = await db
      .update(workflows)
      .set(updateSet)
      .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)))
      .returning();
    if (!result) {
      return { ok: false, error: "NOT_FOUND" };
    }
    return { ok: true, listing: result };
  } catch (err) {
    if (isSlugConflict(err)) {
      return { ok: false, error: "SLUG_CONFLICT" };
    }
    throw err;
  }
}

export async function unlistWorkflow(
  workflowId: string,
  orgId: string
): Promise<ListingResult<typeof workflows.$inferSelect>> {
  const existing = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)))
    .limit(1);

  if (existing.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const [result] = await db
    .update(workflows)
    .set({ isListed: false, updatedAt: new Date() })
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)))
    .returning();

  if (!result) {
    return { ok: false, error: "NOT_FOUND" };
  }

  return { ok: true, listing: result };
}

export async function updateWorkflowListing(
  workflowId: string,
  orgId: string,
  patch: UpdateWorkflowPatch
): Promise<ListingResult<typeof workflows.$inferSelect>> {
  const existing = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)))
    .limit(1);

  if (existing.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const current = existing[0];

  if (patch.priceUsdcPerCall !== undefined && current.isListed === true) {
    return { ok: false, error: "PRICE_CHANGE_WHILE_LISTED" };
  }

  const updateSet: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.category !== undefined) {
    updateSet.category = patch.category;
  }
  if (patch.chain !== undefined) {
    updateSet.chain = patch.chain;
  }
  if (patch.inputSchema !== undefined) {
    updateSet.inputSchema = patch.inputSchema;
  }
  if (patch.outputMapping !== undefined) {
    updateSet.outputMapping = patch.outputMapping;
  }
  if (patch.workflowType !== undefined) {
    updateSet.workflowType = patch.workflowType;
  }
  if (patch.priceUsdcPerCall !== undefined) {
    // Only reachable when isListed === false (price-change-while-listed guard above)
    updateSet.priceUsdcPerCall = patch.priceUsdcPerCall;
  }

  // Same write-workflow guard as listWorkflow: only validate when the row is
  // (or is becoming) listed AND resolves to write. An unlisted draft is allowed
  // to be in a read state with a "write" type still set, but a listed write
  // must have a matching action node.
  const resolvedWorkflowType: "read" | "write" =
    (patch.workflowType as "read" | "write" | undefined) ??
    current.workflowType;
  if (
    current.isListed === true &&
    resolvedWorkflowType === "write" &&
    findFirstWriteActionNode(current.nodes) === undefined
  ) {
    return { ok: false, error: "MISSING_WRITE_ACTION" };
  }

  try {
    const [result] = await db
      .update(workflows)
      .set(updateSet)
      .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)))
      .returning();

    if (!result) {
      return { ok: false, error: "NOT_FOUND" };
    }
    return { ok: true, listing: result };
  } catch (err) {
    if (isSlugConflict(err)) {
      return { ok: false, error: "SLUG_CONFLICT" };
    }
    throw err;
  }
}

export async function getWorkflowListing(
  slug: string
): Promise<ListingResult<ListingRow>> {
  // Public read: only return currently-listed workflows. Unlisting preserves
  // listedSlug (sticky-slug behavior on relist), so filtering by slug alone
  // would leak unlisted workflows' metadata after the unlist. The public
  // catalog at GET /api/mcp/workflows enforces the same invariant.
  const rows = await db
    .select(LISTING_COLUMNS)
    .from(workflows)
    .where(
      and(eq(workflows.listedSlug, slug), eq(workflows.isListed, true))
    )
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  return { ok: true, listing: rows[0] as ListingRow };
}
