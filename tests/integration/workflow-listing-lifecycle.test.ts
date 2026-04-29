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
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          limit: (_n: number) => Promise.resolve([workflowState]),
        }),
      }),
    }),
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

const { listWorkflow, unlistWorkflow } = await import("@/lib/mcp/listing");

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
