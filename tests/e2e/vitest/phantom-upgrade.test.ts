import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type DbSchema,
  discardPhantomRow,
  resolvePhantomToError,
  upgradePhantomToPending,
} from "../../../keeperhub-executor/lib/db-helpers";
import {
  organization,
  users,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";

// tests/setup.ts globally mocks @/lib/db. This suite drives
// upgradePhantomToPending against a real database via its own handle, so
// restore the genuine module.
vi.unmock("@/lib/db");

// The phantom -> pending claim is a compare-and-set in SQL (WHERE
// status='phantom'). It must (a) claim a real phantom row and stamp its input,
// and (b) be a no-op for any row not in 'phantom' (missing, or already advanced
// by a duplicate SQS delivery) so the executor's fallback insert never produces
// a duplicate run. The guard lives in SQL, so this exercises it against a real
// database rather than a mock.

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_keep693_phantom_";

type ExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "phantom";

describe.skipIf(SKIP)("upgradePhantomToPending", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  // upgradePhantomToPending is typed against the executor's DbSchema; the
  // test's schema-less handle is structurally compatible for the .update() it
  // issues.
  let execDb: PostgresJsDatabase<DbSchema>;

  const ownerId = `${PREFIX}user`;
  const orgId = `${PREFIX}org`;
  const workflowId = `${PREFIX}wf`;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function seedExecution(
    id: string,
    status: ExecutionStatus,
    input: Record<string, unknown> | null = null
  ): Promise<void> {
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status,
      input,
    });
  }

  async function readExecution(id: string) {
    const [row] = await db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, id));
    return row;
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    execDb = db as unknown as PostgresJsDatabase<DbSchema>;
    await cleanup();

    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@keep693.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organization).values({
      id: orgId,
      name: orgId,
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(workflows).values({
      id: workflowId,
      name: workflowId,
      userId: ownerId,
      organizationId: orgId,
      nodes: [],
      edges: [],
      visibility: "private",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("upgrades a phantom row to pending and stamps its input", async () => {
    const id = `${PREFIX}claim`;
    await seedExecution(id, "phantom");

    const upgraded = await upgradePhantomToPending(execDb, id, {
      triggered: 1,
    });

    expect(upgraded).toBe(true);
    const row = await readExecution(id);
    expect(row.status).toBe("pending");
    expect(row.input).toEqual({ triggered: 1 });
  });

  it("is a no-op (returns false) when the row is not phantom", async () => {
    const id = `${PREFIX}running`;
    await seedExecution(id, "running", { original: true });

    const upgraded = await upgradePhantomToPending(execDb, id, { stamped: 2 });

    expect(upgraded).toBe(false);
    const row = await readExecution(id);
    expect(row.status).toBe("running");
    // Input must be untouched -- the CAS matched no row.
    expect(row.input).toEqual({ original: true });
  });

  it("returns false when the execution id does not exist", async () => {
    const upgraded = await upgradePhantomToPending(
      execDb,
      `${PREFIX}missing`,
      {}
    );
    expect(upgraded).toBe(false);
  });

  it("is idempotent: a second claim of an already-upgraded row returns false", async () => {
    const id = `${PREFIX}dup`;
    await seedExecution(id, "phantom");

    const first = await upgradePhantomToPending(execDb, id, { n: 1 });
    const second = await upgradePhantomToPending(execDb, id, { n: 2 });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const row = await readExecution(id);
    expect(row.status).toBe("pending");
    // The losing duplicate must not overwrite the input the winner stamped.
    expect(row.input).toEqual({ n: 1 });
  });

  it("upgrade flips a non-billable phantom to billable (it now runs)", async () => {
    const id = `${PREFIX}billable`;
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status: "phantom",
      billable: false,
    });

    const upgraded = await upgradePhantomToPending(execDb, id, {});

    expect(upgraded).toBe(true);
    const row = await readExecution(id);
    expect(row.status).toBe("pending");
    expect(row.billable).toBe(true);
  });

  it("discardPhantomRow deletes a phantom row (intentional skip)", async () => {
    const id = `${PREFIX}discard`;
    await seedExecution(id, "phantom");

    await discardPhantomRow(execDb, id);

    expect(await readExecution(id)).toBeUndefined();
  });

  it("discardPhantomRow leaves a non-phantom row intact", async () => {
    const id = `${PREFIX}discard_running`;
    await seedExecution(id, "running");

    await discardPhantomRow(execDb, id);

    expect((await readExecution(id))?.status).toBe("running");
  });

  it("resolvePhantomToError marks a phantom as a billing/user error", async () => {
    const id = `${PREFIX}resolve`;
    await seedExecution(id, "phantom");

    await resolvePhantomToError(execDb, id, {
      error: "over quota",
      errorCategory: "billing",
      errorType: "user",
    });

    const row = await readExecution(id);
    expect(row.status).toBe("error");
    expect(row.error).toBe("over quota");
    expect(row.errorCategory).toBe("billing");
    expect(row.errorType).toBe("user");
    // User-actionable errors carry no system code.
    expect(row.errorCode).toBeNull();
  });

  it("resolvePhantomToError leaves a non-phantom row intact", async () => {
    const id = `${PREFIX}resolve_running`;
    await seedExecution(id, "running");

    await resolvePhantomToError(execDb, id, {
      error: "x",
      errorCategory: "billing",
      errorType: "user",
    });

    expect((await readExecution(id))?.status).toBe("running");
  });
});
