import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    WORKFLOW_ENGINE: "workflow_engine",
    DATABASE: "database",
  },
  logSystemError: vi.fn(),
}));

// Hoisted schema stubs so the vi.mock factory can reference them.
const { workflowExecutionsMock, workflowExecutionLogsMock } = vi.hoisted(
  () => ({
    workflowExecutionsMock: {
      id: "id",
      status: "status",
      output: "output",
      error: "error",
      completedAt: "completed_at",
      duration: "duration",
      currentNodeId: "current_node_id",
      currentNodeName: "current_node_name",
    },
    workflowExecutionLogsMock: {
      id: "id",
      executionId: "execution_id",
      status: "status",
      error: "error",
      completedAt: "completed_at",
    },
  })
);

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: workflowExecutionsMock,
  workflowExecutionLogs: workflowExecutionLogsMock,
}));

// State the tests mutate between runs.
type UpdateCall = {
  target: unknown;
  set: Record<string, unknown>;
};
let unresolvedLogs: { id: string; status: string }[] = [];
let updateCalls: UpdateCall[] = [];
let updateShouldThrow = false;

type WhereChain = Promise<void>;
type SetChain = { where: () => WhereChain };
type UpdateChain = { set: (values: Record<string, unknown>) => SetChain };

function buildUpdate(target: unknown): UpdateChain {
  return {
    set: (values: Record<string, unknown>): SetChain => {
      updateCalls.push({ target, set: values });
      if (updateShouldThrow) {
        return {
          where: (): WhereChain => Promise.reject(new Error("db down")),
        };
      }
      return {
        where: (): WhereChain => Promise.resolve(),
      };
    },
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutionLogs: {
        findMany: vi.fn(() => Promise.resolve(unresolvedLogs)),
      },
    },
    update: vi.fn((target: unknown) => buildUpdate(target)),
  },
}));

import { logWorkflowCompleteDb } from "@/lib/workflow-logging";

function getExecUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === workflowExecutionsMock);
}

function getLogUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === workflowExecutionLogsMock);
}

describe("logWorkflowCompleteDb", () => {
  beforeEach(() => {
    unresolvedLogs = [];
    updateCalls = [];
    updateShouldThrow = false;
    vi.clearAllMocks();
  });

  it("writes success status unchanged when workflow succeeded", async () => {
    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      output: { ok: true },
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "success",
        output: { ok: true },
      })
    );
  });

  it("keeps error status when a node log recorded an error", async () => {
    unresolvedLogs = [{ id: "log_1", status: "error" }];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "Step failed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "error",
        error: "Step failed",
      })
    );
  });

  it("overrides spurious SDK error to success when no logs are error or running", async () => {
    unresolvedLogs = [];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "exceeded max retries",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "success",
        error: undefined,
      })
    );
  });

  // KEEP-333: If a step started but never recorded completion, the workflow
  // really is incomplete. Don't lie to the user by overriding to success.
  it("keeps error status when any log is stuck in running", async () => {
    unresolvedLogs = [{ id: "log_running", status: "running" }];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "worker killed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "error",
        error: "worker killed",
      })
    );
  });

  it("closes orphaned running logs on completion (error path)", async () => {
    unresolvedLogs = [{ id: "log_running", status: "running" }];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "worker killed",
      startTime: Date.now() - 1000,
    });

    const logUpdate = getLogUpdate();
    expect(logUpdate).toBeDefined();
    expect(logUpdate?.set).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("did not record completion"),
        completedAt: expect.any(Date),
      })
    );
  });

  it("closes orphaned running logs as success when workflow succeeded", async () => {
    // Spurious SDK error reconciled to success; any running rows should
    // match the reconciled status so the UI is consistent.
    unresolvedLogs = [];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      startTime: Date.now() - 1000,
    });

    const logUpdate = getLogUpdate();
    expect(logUpdate).toBeDefined();
    expect(logUpdate?.set).toEqual(
      expect.objectContaining({
        status: "success",
      })
    );
    // On success we don't attach a "did not record completion" error.
    expect(logUpdate?.set.error).toBeUndefined();
  });

  it("still updates execution status when log cleanup throws", async () => {
    // Simulate a transient DB failure during the log cleanup UPDATE;
    // the execution status update must still run.
    unresolvedLogs = [];
    let callIndex = 0;
    updateShouldThrow = false;

    // Patch buildUpdate behavior per-call: first UPDATE (logs) throws,
    // second UPDATE (executions) succeeds.
    const { db } = await import("@/lib/db");
    (db.update as unknown as {
      mockImplementation: (fn: (t: unknown) => UpdateChain) => void;
    }).mockImplementation((target: unknown) => ({
      set: (values: Record<string, unknown>): SetChain => {
        updateCalls.push({ target, set: values });
        const shouldThrow =
          callIndex === 0 && target === workflowExecutionLogsMock;
        callIndex += 1;
        return {
          where: (): WhereChain =>
            shouldThrow
              ? Promise.reject(new Error("transient db failure"))
              : Promise.resolve(),
        };
      },
    }));

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      startTime: Date.now() - 1000,
    });

    // Execution update still ran despite the log cleanup throwing.
    expect(getExecUpdate()).toBeDefined();
  });
});
