/**
 * Integration test for the workflow listing lifecycle (list -> unlist -> relist).
 *
 * Tests lib/mcp/listing.ts state machine helpers directly with an in-memory
 * Drizzle mock. Cross-org 404 behaviour is covered in
 * tests/unit/mcp-curator-tools.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type WorkflowRow = {
  id: string;
  organizationId: string;
  isListed: boolean;
  listedSlug: string | null;
  listedAt: Date | null;
  priceUsdcPerCall: string | null;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  category: string | null;
  chain: string | null;
  workflowType: "read" | "write";
  createdAt: Date;
  updatedAt: Date;
};

let workflowState: WorkflowRow;

vi.mock("@/lib/db", () => ({
  db: {
    select: (cols?: unknown) => {
      // getWorkflowListing projects LISTING_COLUMNS (which includes listedSlug)
      // and is a public read — must honour the isListed=true filter. Other
      // selects (e.g. updateWorkflowListing's pre-flight by id+orgId) use
      // db.select() with no columns and ignore the listing invariant.
      const isPublicListingRead =
        cols !== undefined &&
        cols !== null &&
        typeof cols === "object" &&
        "listedSlug" in (cols as Record<string, unknown>);
      return {
        from: (_table: unknown) => ({
          where: (_condition: unknown) => ({
            limit: (_n: number) => {
              if (isPublicListingRead && !workflowState.isListed) {
                return Promise.resolve([]);
              }
              return Promise.resolve([workflowState]);
            },
          }),
        }),
      };
    },
    update: (_table: unknown) => ({
      set: (data: Partial<WorkflowRow>) => ({
        where: (_condition: unknown) => ({
          returning: () => {
            Object.assign(workflowState, data);
            return Promise.resolve([workflowState]);
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    organizationId: "organizationId",
    isListed: "isListed",
    listedSlug: "listedSlug",
    listedAt: "listedAt",
    name: "name",
    description: "description",
    inputSchema: "inputSchema",
    outputMapping: "outputMapping",
    priceUsdcPerCall: "priceUsdcPerCall",
    category: "category",
    chain: "chain",
    workflowType: "workflowType",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
}));

const { listWorkflow, unlistWorkflow, getWorkflowListing } = await import("@/lib/mcp/listing");

const WORKFLOW_ID = "wf-test-001";
const ORG_ID = "org-test-001";

describe("workflow listing lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowState = {
      id: WORKFLOW_ID,
      organizationId: ORG_ID,
      isListed: false,
      listedSlug: null,
      listedAt: null,
      priceUsdcPerCall: null,
      name: "Test Workflow",
      description: null,
      inputSchema: null,
      outputMapping: null,
      category: null,
      chain: null,
      workflowType: "read",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
  });

  it("list: sets isListed=true, assigns listedSlug, sets listedAt", async () => {
    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, { slug: "my-test-workflow" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.isListed).toBe(true);
    expect(result.listing.listedSlug).toBe("my-test-workflow");
    expect(result.listing.listedAt).toBeInstanceOf(Date);
  });

  it("unlist: sets isListed=false, preserves listedSlug and listedAt", async () => {
    await listWorkflow(WORKFLOW_ID, ORG_ID, { slug: "my-test-workflow" });
    const listingTimestamp = workflowState.listedAt;

    const result = await unlistWorkflow(WORKFLOW_ID, ORG_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.isListed).toBe(false);
    expect(result.listing.listedSlug).toBe("my-test-workflow");
    expect(result.listing.listedAt?.getTime()).toBe(listingTimestamp?.getTime());
  });

  it("getWorkflowListing: returns NOT_FOUND for unlisted workflow even when listedSlug is preserved (sticky-slug)", async () => {
    // Public read invariant: an unlisted workflow MUST NOT leak metadata via the
    // public GET endpoint, even though unlistWorkflow intentionally preserves
    // listedSlug for relist. Without the isListed=true filter this query
    // returned the unlisted row, exposing price/schemas/orgId publicly.
    await listWorkflow(WORKFLOW_ID, ORG_ID, { slug: "leak-test" });
    expect(workflowState.listedSlug).toBe("leak-test");

    const listedRead = await getWorkflowListing("leak-test");
    expect(listedRead.ok).toBe(true);

    await unlistWorkflow(WORKFLOW_ID, ORG_ID);
    expect(workflowState.isListed).toBe(false);
    expect(workflowState.listedSlug).toBe("leak-test");

    const unlistedRead = await getWorkflowListing("leak-test");
    expect(unlistedRead.ok).toBe(false);
    if (unlistedRead.ok) return;
    expect(unlistedRead.error).toBe("NOT_FOUND");
  });

  it("relist: preserves listedSlug, refreshes listedAt, isListed=true", async () => {
    await listWorkflow(WORKFLOW_ID, ORG_ID, { slug: "my-test-workflow" });
    const firstListedAt = workflowState.listedAt as Date;

    await unlistWorkflow(WORKFLOW_ID, ORG_ID);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });

    // Relist without passing slug — existing listedSlug should be preserved
    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.isListed).toBe(true);
    expect(result.listing.listedSlug).toBe("my-test-workflow");
    expect(result.listing.listedAt).toBeInstanceOf(Date);
    expect((result.listing.listedAt as Date).getTime()).toBeGreaterThan(
      firstListedAt.getTime()
    );
  });
});
