import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { users, workflows, workflowSchedules } from "../../../lib/db/schema";

// tests/setup.ts globally mocks @/lib/db with a stub query builder. This suite
// drives the real route against a real database, so restore the genuine module.
vi.unmock("@/lib/db");

// Proves the scheduler select only returns due workflows that are actually
// runnable: enabled, not soft-deleted, and owned by an active user. The query
// filtering lives in SQL, so this exercises it against a real database rather
// than a mock (a mock returns rows regardless of the WHERE clause).

// Mirror the full-pipeline e2e gate: skip when no database is available. Note
// tests/setup.ts defaults DATABASE_URL, so CI without infra signals via
// SKIP_INFRA_TESTS rather than an unset URL.
const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const SERVICE_KEY = "test-scheduler-lifecycle-key";

// The route reads service keys from the environment at import time, so this
// must be set before the dynamic import in beforeAll.
process.env.SCHEDULER_SERVICE_API_KEY = SERVICE_KEY;

const PREFIX = "test_keep611_lifecycle_";

type GetHandler = (request: Request) => Promise<Response>;

describe.skipIf(SKIP)("scheduler lifecycle filtering", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let GET: GetHandler;

  const activeOwnerId = `${PREFIX}user_active`;
  const deactivatedOwnerId = `${PREFIX}user_deactivated`;

  const healthyWorkflowId = `${PREFIX}wf_healthy`;
  const deactivatedOwnerWorkflowId = `${PREFIX}wf_deactivated_owner`;
  const softDeletedWorkflowId = `${PREFIX}wf_soft_deleted`;
  const disabledWorkflowId = `${PREFIX}wf_disabled`;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflow_schedules WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function seedUser(id: string, deactivatedAt: Date | null): Promise<void> {
    await db.insert(users).values({
      id,
      email: `${id}@keep611.test`,
      emailVerified: false,
      deactivatedAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedWorkflow(
    id: string,
    userId: string,
    options: { enabled: boolean; deletedAt: Date | null }
  ): Promise<void> {
    await db.insert(workflows).values({
      id,
      name: id,
      userId,
      nodes: [],
      edges: [],
      visibility: "private",
      enabled: options.enabled,
      deletedAt: options.deletedAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedSchedule(workflowId: string): Promise<void> {
    await db.insert(workflowSchedules).values({
      id: `${PREFIX}sched_${workflowId}`,
      workflowId,
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    await seedUser(activeOwnerId, null);
    await seedUser(deactivatedOwnerId, new Date());

    await seedWorkflow(healthyWorkflowId, activeOwnerId, {
      enabled: true,
      deletedAt: null,
    });
    await seedWorkflow(deactivatedOwnerWorkflowId, deactivatedOwnerId, {
      enabled: true,
      deletedAt: null,
    });
    await seedWorkflow(softDeletedWorkflowId, activeOwnerId, {
      enabled: true,
      deletedAt: new Date(),
    });
    await seedWorkflow(disabledWorkflowId, activeOwnerId, {
      enabled: false,
      deletedAt: null,
    });

    await seedSchedule(healthyWorkflowId);
    await seedSchedule(deactivatedOwnerWorkflowId);
    await seedSchedule(softDeletedWorkflowId);
    await seedSchedule(disabledWorkflowId);

    ({ GET } = (await import(
      "../../../app/api/internal/schedules/route"
    )) as { GET: GetHandler });
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("returns the healthy workflow's schedule but excludes deleted, disabled, and deactivated-owner ones", async () => {
    const response = await GET(
      new Request("http://localhost/api/internal/schedules", {
        headers: { "X-Service-Key": SERVICE_KEY },
      })
    );
    expect(response.status).toBe(200);

    const { schedules } = (await response.json()) as {
      schedules: { workflowId: string }[];
    };
    const returnedWorkflowIds = new Set(schedules.map((s) => s.workflowId));

    expect(returnedWorkflowIds.has(healthyWorkflowId)).toBe(true);
    expect(returnedWorkflowIds.has(deactivatedOwnerWorkflowId)).toBe(false);
    expect(returnedWorkflowIds.has(softDeletedWorkflowId)).toBe(false);
    expect(returnedWorkflowIds.has(disabledWorkflowId)).toBe(false);
  });

  it("starts returning the schedule once the owner is reactivated", async () => {
    await db
      .update(users)
      .set({ deactivatedAt: null })
      .where(eq(users.id, deactivatedOwnerId));

    const response = await GET(
      new Request("http://localhost/api/internal/schedules", {
        headers: { "X-Service-Key": SERVICE_KEY },
      })
    );
    const { schedules } = (await response.json()) as {
      schedules: { workflowId: string }[];
    };
    const returnedWorkflowIds = new Set(schedules.map((s) => s.workflowId));

    expect(returnedWorkflowIds.has(deactivatedOwnerWorkflowId)).toBe(true);
  });
});
