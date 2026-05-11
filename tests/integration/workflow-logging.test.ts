import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    WORKFLOW_ENGINE: "workflow_engine",
    DATABASE: "database",
  },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
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
      nodeId: "node_id",
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
type LogRow = { id?: string; nodeId: string; status: string };
let allLogs: LogRow[] = [];
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
        findMany: vi.fn(() => Promise.resolve(allLogs)),
      },
    },
    update: vi.fn((target: unknown) => buildUpdate(target)),
  },
}));

import { logSystemError, logSystemWarn } from "@/lib/logging";
import { logWorkflowCompleteDb } from "@/lib/workflow/executor/logging";

function getExecUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === workflowExecutionsMock);
}

function getLogUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === workflowExecutionLogsMock);
}

describe("logWorkflowCompleteDb", () => {
  beforeEach(() => {
    allLogs = [];
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

  it("keeps error status when a node log recorded an error and never succeeded", async () => {
    allLogs = [{ id: "log_1", nodeId: "node_a", status: "error" }];

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
    allLogs = [
      { id: "log_a", nodeId: "node_a", status: "success" },
      { id: "log_b", nodeId: "node_b", status: "success" },
    ];

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

    // KEEP-532 regression guard: both the pre-reconciliation log and the
    // spurious-recovery log must route through logSystemWarn (no metric),
    // not logSystemError (which would re-trip errors.system.workflow_engine.total).
    expect(logSystemWarn).toHaveBeenCalledTimes(2);
    expect(logSystemWarn).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("checking node logs for reconciliation"),
      expect.anything(),
      expect.objectContaining({ execution_id: "exec_1" })
    );
    expect(logSystemWarn).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("overriding spurious SDK error to success"),
      expect.anything(),
      expect.objectContaining({ execution_id: "exec_1" })
    );
    expect(logSystemError).not.toHaveBeenCalled();
  });

  // KEEP-333: If a step started but never recorded completion, the workflow
  // really is incomplete. Don't lie to the user by overriding to success.
  it("keeps error status when a node has only a running log (no success row)", async () => {
    allLogs = [{ id: "log_running", nodeId: "node_a", status: "running" }];

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

  // KEEP-431: cross-pod SDK checkpoint resume. The original step body
  // succeeded on pod A and recorded a success row. The framework re-fired
  // the step on pod B; that retry's logStepStartDb inserted a 'running'
  // row, but the SDK threw "exceeded max retries" before logStepCompleteDb
  // ran for the retry. The success row from pod A is the truth.
  it("overrides spurious error when node has both success and running rows (cross-pod retry)", async () => {
    allLogs = [
      // First read row succeeded normally on pod A
      { id: "log_read1", nodeId: "read1", status: "success" },
      // Combine succeeded on pod A then framework re-fired on pod B
      { id: "log_combine_success", nodeId: "combine", status: "success" },
      { id: "log_combine_orphan", nodeId: "combine", status: "running" },
    ];

    await logWorkflowCompleteDb({
      executionId: "exec_x402_cross_pod",
      status: "error",
      error: 'Step "runCodeStep" exceeded max retries (1 retry)',
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "success",
        error: undefined,
      })
    );
  });

  it("overrides spurious error when node has both success and error rows from retry", async () => {
    allLogs = [
      { id: "log_combine_success", nodeId: "combine", status: "success" },
      // Retry attempt rejected by SDK and logStepComplete recorded error.
      { id: "log_combine_retry", nodeId: "combine", status: "error" },
    ];

    await logWorkflowCompleteDb({
      executionId: "exec_retry_error",
      status: "error",
      error: "Step did not record completion",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "success",
        error: undefined,
      })
    );
  });

  it("keeps error status when one node truly failed even if others have retries", async () => {
    allLogs = [
      // node_a: cross-pod retry pattern, would otherwise succeed.
      { id: "log_a_success", nodeId: "node_a", status: "success" },
      { id: "log_a_orphan", nodeId: "node_a", status: "running" },
      // node_b: real failure, no success row anywhere.
      { id: "log_b_error", nodeId: "node_b", status: "error" },
    ];

    await logWorkflowCompleteDb({
      executionId: "exec_mixed",
      status: "error",
      error: "node_b failed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "error",
        error: "node_b failed",
      })
    );
  });

  it("closes orphaned running logs on completion (error path)", async () => {
    allLogs = [{ id: "log_running", nodeId: "node_a", status: "running" }];

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
    allLogs = [];

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
    allLogs = [];
    let callIndex = 0;
    updateShouldThrow = false;

    // Patch buildUpdate behavior per-call: first UPDATE (logs) throws,
    // second UPDATE (executions) succeeds.
    const { db } = await import("@/lib/db");
    (
      db.update as unknown as {
        mockImplementation: (fn: (t: unknown) => UpdateChain) => void;
      }
    ).mockImplementation((target: unknown) => ({
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
