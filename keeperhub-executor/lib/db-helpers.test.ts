import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A transitive lib import (the classifier -> lib/logging) is server-only; stub
// the guard so db-helpers imports under vitest, same pattern as the other
// executor suites.
vi.mock("server-only", () => ({}));

// The terminal-counter emit dynamic-imports the prometheus collector and hits
// the DB for the org slug. Stub it so these tests stay a focused unit on the
// row write; a separate assertion checks it is invoked with the persisted
// classification.
const { recordTerminalSampleMock } = vi.hoisted(() => ({
  recordTerminalSampleMock: vi.fn(),
}));
vi.mock("./terminal-counters", () => ({
  recordTerminalSample: recordTerminalSampleMock,
}));

import type { DbSchema } from "./db-helpers";
import { updateExecutionStatus } from "./db-helpers";

type SetData = Record<string, unknown>;

type UpdateBuilder = {
  set: (data: SetData) => UpdateBuilder;
  where: () => UpdateBuilder;
  returning: () => Promise<Array<{ workflowId: string }>>;
};

type MockDb = {
  db: PostgresJsDatabase<DbSchema>;
  captured: { setData: SetData | null };
};

/**
 * Minimal fake of the drizzle chain updateExecutionStatus uses
 * (db.update(...).set(...).where(...).returning(...)). `returningRows` controls
 * whether the guarded CAS matched a row: a non-empty array simulates the
 * backstop winning the terminal transition, an empty array simulates a no-op
 * because the engine already closed the row.
 */
function makeDb(returningRows: Array<{ workflowId: string }>): MockDb {
  const captured: { setData: SetData | null } = { setData: null };
  const builder: UpdateBuilder = {
    set(data: SetData): UpdateBuilder {
      captured.setData = data;
      return builder;
    },
    where(): UpdateBuilder {
      return builder;
    },
    returning(): Promise<Array<{ workflowId: string }>> {
      return Promise.resolve(returningRows);
    },
  };
  const db = { update: (): UpdateBuilder => builder };
  return { db: db as unknown as PostgresJsDatabase<DbSchema>, captured };
}

describe("updateExecutionStatus classification", () => {
  beforeEach(() => {
    recordTerminalSampleMock.mockReset();
  });

  it("promotes a confidently system failure to system_error and persists the classification", async () => {
    const { db, captured } = makeDb([{ workflowId: "wf1" }]);

    await updateExecutionStatus(db, "e1", "error", {
      error: "Workflow terminated by SIGTERM signal",
    });

    expect(captured.setData).toMatchObject({
      status: "system_error",
      error: "Workflow terminated by SIGTERM signal",
      errorType: "system",
      errorCategory: "infrastructure",
      errorCode: "P-0003",
    });
    expect(captured.setData?.completedAt).toBeInstanceOf(Date);
    expect(recordTerminalSampleMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workflowId: "wf1",
        status: "system_error",
        errorType: "system",
        errorCategory: "infrastructure",
      })
    );
  });

  it("keeps status=error for a user-classified failure and writes error_type=user", async () => {
    const { db, captured } = makeDb([{ workflowId: "wf1" }]);

    await updateExecutionStatus(db, "e1", "error", {
      error: "Unresolved template reference {{@node1.output}}",
    });

    expect(captured.setData).toMatchObject({
      status: "error",
      errorType: "user",
      errorCategory: "configuration",
      errorCode: null,
    });
  });

  it("writes a default classification (error_type=system) for an unmatched message without promoting", async () => {
    const { db, captured } = makeDb([{ workflowId: "wf1" }]);

    await updateExecutionStatus(db, "e1", "error", {
      error: "totally unrecognized boom",
    });

    expect(captured.setData).toMatchObject({
      status: "error",
      errorType: "system",
      errorCategory: "workflow_engine",
      errorCode: "C-0001",
    });
  });

  it("does not emit a terminal sample when the guarded update matched no row", async () => {
    const { db } = makeDb([]);

    await updateExecutionStatus(db, "e1", "error", { error: "boom" });

    expect(recordTerminalSampleMock).not.toHaveBeenCalled();
  });

  it("does not classify or set error columns for a non-error status", async () => {
    const { db, captured } = makeDb([{ workflowId: "wf1" }]);

    await updateExecutionStatus(db, "e1", "success", { output: { ok: true } });

    expect(captured.setData?.status).toBe("success");
    expect(captured.setData).not.toHaveProperty("errorType");
    expect(captured.setData).not.toHaveProperty("errorCategory");
    expect(captured.setData).not.toHaveProperty("errorCode");
    expect(recordTerminalSampleMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ status: "success" })
    );
  });
});
