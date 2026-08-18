import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UnifiedRun } from "../../../lib/analytics/types";
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db; this suite needs getUnifiedRuns to
// hit Postgres, because the behaviour under test is which rows survive the
// log-summary subquery's WHERE clause - not the shape of the generated SQL.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_run_network_";
const ORG_ID = `${PREFIX}org`;
const USER_ID = `${PREFIX}user`;
const WORKFLOW_ID = `${PREFIX}wf`;

/** A run that failed before broadcast: its step named a chain, spent no gas. */
const PREFLIGHT_ID = `${PREFIX}exec_preflight`;
/** A run whose gas-bearing step and read-only step sit on different chains. */
const MIXED_ID = `${PREFIX}exec_mixed`;

describe.skipIf(SKIP)("run network on a pre-broadcast failure", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getUnifiedRuns: (
    organizationId: string,
    range: "7d",
    options?: { limit?: number }
  ) => Promise<{ runs: UnifiedRun[] }>;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM member WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();

    await db.insert(organization).values({
      id: ORG_ID,
      name: "run network org",
      slug: ORG_ID,
      createdAt: now,
    });
    await db.insert(users).values({
      id: USER_ID,
      email: `${USER_ID}@keeperhub.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflows).values({
      id: WORKFLOW_ID,
      name: "run network workflow",
      userId: USER_ID,
      organizationId: ORG_ID,
      enabled: true,
      nodes: [],
      edges: [],
    });

    await db.insert(workflowExecutions).values({
      id: PREFLIGHT_ID,
      workflowId: WORKFLOW_ID,
      userId: USER_ID,
      status: "error" as const,
      error: "Insufficient BASE balance",
      startedAt: now,
      completedAt: now,
      totalSteps: "1",
      completedSteps: "0",
    });
    await db.insert(workflowExecutions).values({
      id: MIXED_ID,
      workflowId: WORKFLOW_ID,
      userId: USER_ID,
      status: "success" as const,
      startedAt: now,
      completedAt: now,
      totalSteps: "2",
      completedSteps: "2",
    });

    // logging.ts writes network/gas into both the JSONB and the denormalised
    // columns, so the fixture populates both: the failure this suite asserts
    // must come from the subquery's gas predicate, not from a half-seeded row
    // that only the column-reading variant can see.
    await db.insert(workflowExecutionLogs).values([
      {
        id: `${PREFIX}log_preflight`,
        executionId: PREFLIGHT_ID,
        nodeId: "send-1",
        nodeName: "Send",
        nodeType: "web3",
        status: "error",
        input: { network: "base" },
        error: "Insufficient BASE balance",
        startedAt: now,
        network: "base",
        gasUsedWei: null,
      },
      {
        id: `${PREFIX}log_mixed_write`,
        executionId: MIXED_ID,
        nodeId: "swap-1",
        nodeName: "Swap",
        nodeType: "web3",
        status: "success",
        input: { network: "base" },
        output: { gasUsed: "21000" },
        startedAt: now,
        network: "base",
        gasUsedWei: "21000",
      },
      {
        id: `${PREFIX}log_mixed_read`,
        executionId: MIXED_ID,
        nodeId: "read-1",
        nodeName: "Read balance",
        nodeType: "web3",
        status: "success",
        input: { network: "optimism" },
        startedAt: now,
        network: "optimism",
        gasUsedWei: null,
      },
    ]);

    ({ getUnifiedRuns } = await import("@/lib/analytics/queries"));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  async function runById(id: string): Promise<UnifiedRun> {
    const { runs } = await getUnifiedRuns(ORG_ID, "7d", { limit: 50 });
    const run = runs.find((r) => r.id === id);
    if (!run) {
      throw new Error(`seeded run ${id} missing from getUnifiedRuns`);
    }
    return run;
  }

  it("keeps the chain on a run that spent no gas", async () => {
    const run = await runById(PREFLIGHT_ID);
    expect(run.network).toBe("base");
    expect(run.networks).toEqual(["base"]);
    // No gas was spent, and that must stay distinguishable from "no chain".
    expect(run.gasUsedWei).toBeNull();
  });

  it("still prefers the gas-bearing step's chain as the run's network", async () => {
    const run = await runById(MIXED_ID);
    expect(run.network).toBe("base");
    expect(run.gasUsedWei).toBe("21000");
  });

  it("lists every chain the run's steps targeted, gas-bearing or not", async () => {
    const run = await runById(MIXED_ID);
    expect([...run.networks].sort()).toEqual(["base", "optimism"]);
  });
});
