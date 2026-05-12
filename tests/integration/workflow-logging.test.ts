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

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
  }),
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
      // KEEP-470: column referenced by terminal UPDATE SET clauses
      transactionHashes: "transaction_hashes",
    },
    workflowExecutionLogsMock: {
      id: "id",
      executionId: "execution_id",
      nodeId: "node_id",
      nodeName: "node_name",
      status: "status",
      error: "error",
      completedAt: "completed_at",
      // KEEP-470: columns referenced by loadHashesFromLogs SELECT
      iterationIndex: "iteration_index",
      outputRaw: "output_raw",
      startedAt: "started_at",
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
type ExecutionRow = {
  status: string;
  error?: string | null;
  completedAt?: Date | null;
  startedAt?: Date | null;
};
let allLogs: LogRow[] = [];
let updateCalls: UpdateCall[] = [];
let updateShouldThrow = false;
let mockExecution: ExecutionRow | null = null;

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
      workflowExecutions: {
        findFirst: vi.fn(() => Promise.resolve(mockExecution)),
      },
    },
    update: vi.fn((target: unknown) => buildUpdate(target)),
  },
}));

import { db } from "@/lib/db";
import { logSystemError, logSystemWarn } from "@/lib/logging";
import {
  logStepCompleteDb,
  logWorkflowCompleteDb,
} from "@/lib/workflow/executor/logging";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import {
  clearExecution,
  recordTransactionHashIfPresent,
} from "@/lib/workflow/executor/step-success-tracker";

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

// KEEP-470: top-level transactionHashes persistence at workflow completion.
describe("logWorkflowCompleteDb transactionHashes (KEEP-470)", () => {
  function ctx(overrides: Partial<StepContext>): StepContext {
    return {
      executionId: overrides.executionId ?? "exec_keep_470",
      nodeId: "write-contract-1",
      nodeName: "Write Contract",
      nodeType: "web3/write-contract",
      ...overrides,
    };
  }

  beforeEach(() => {
    allLogs = [];
    updateCalls = [];
    updateShouldThrow = false;
    vi.clearAllMocks();
  });

  it("writes the in-memory tracker entries verbatim on success", async () => {
    const executionId = "exec_tracker_path";
    recordTransactionHashIfPresent(
      ctx({ executionId, nodeId: "approve-1", nodeName: "Approve" }),
      { transactionHash: "0xaaa", chainId: 1, network: "mainnet" }
    );
    recordTransactionHashIfPresent(
      ctx({ executionId, nodeId: "swap-1", nodeName: "Swap" }),
      { transactionHash: "0xbbb", chainId: 1, network: "mainnet" }
    );

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const update = getExecUpdate();
    expect(update?.set.status).toBe("success");
    expect(update?.set.transactionHashes).toEqual([
      {
        hash: "0xaaa",
        nodeId: "approve-1",
        nodeName: "Approve",
        chainId: 1,
        network: "mainnet",
      },
      {
        hash: "0xbbb",
        nodeId: "swap-1",
        nodeName: "Swap",
        chainId: 1,
        network: "mainnet",
      },
    ]);

    clearExecution(executionId);
  });

  it("writes an empty array on error terminations", async () => {
    const executionId = "exec_error_no_hashes";
    // Even if the tracker has data (e.g. partial run before error), an
    // error termination must not pollute transactionHashes -- we have no
    // signal that an error run's hashes should surface at the top level.
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "0xshouldnotappear",
      chainId: 1,
      network: "mainnet",
    });
    allLogs = [{ id: "log_a", nodeId: "node_a", status: "error" }];

    await logWorkflowCompleteDb({
      executionId,
      status: "error",
      error: "Step failed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set.transactionHashes).toEqual([]);

    clearExecution(executionId);
  });

  it("falls back to workflow_execution_logs.output_raw when tracker is empty (cross-pod resume)", async () => {
    const executionId = "exec_fallback_path";
    // Tracker is empty (simulating finalize on a different pod).
    allLogs = [
      {
        id: "log_a",
        nodeId: "approve-1",
        nodeName: "Approve",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xccc",
          chainId: 1,
          network: "mainnet",
        },
      },
      {
        id: "log_b",
        nodeId: "swap-1",
        nodeName: "Swap",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xddd",
          chainId: 1,
          network: "mainnet",
        },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Array<{
      hash: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.hash)).toEqual(["0xccc", "0xddd"]);
  });

  it("fallback dedupes by hash string (SDK retry that re-broadcasts)", async () => {
    const executionId = "exec_dedupe";
    allLogs = [
      {
        id: "log_first",
        nodeId: "transfer-1",
        nodeName: "Send",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: "0xshared", chainId: 1 },
      },
      {
        id: "log_retry",
        nodeId: "transfer-1",
        nodeName: "Send",
        status: "success",
        iterationIndex: null,
        // Same hash echoed by a retry that re-fired - must dedupe.
        outputRaw: { transactionHash: "0xshared", chainId: 1 },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Array<{
      hash: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe("0xshared");
  });

  it("fallback omits optional fields when outputRaw / iterationIndex lack them", async () => {
    const executionId = "exec_omit_optionals";
    allLogs = [
      {
        id: "log_no_chain",
        nodeId: "custom-step-1",
        nodeName: "Custom",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: "0xnochain" },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Record<
      string,
      unknown
    >[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      hash: "0xnochain",
      nodeId: "custom-step-1",
      nodeName: "Custom",
    });
    expect("chainId" in entries[0]).toBe(false);
    expect("network" in entries[0]).toBe(false);
    expect("iterationIndex" in entries[0]).toBe(false);
  });

  it("fallback emits iterationIndex when log row was a For-Each iteration", async () => {
    const executionId = "exec_foreach_fallback";
    allLogs = [
      {
        id: "log_iter_0",
        nodeId: "transfer-funds-1",
        nodeName: "Send airdrop",
        status: "success",
        iterationIndex: 0,
        outputRaw: { transactionHash: "0xiter0", chainId: 1 },
      },
      {
        id: "log_iter_1",
        nodeId: "transfer-funds-1",
        nodeName: "Send airdrop",
        status: "success",
        iterationIndex: 1,
        outputRaw: { transactionHash: "0xiter1", chainId: 1 },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Array<{
      hash: string;
      iterationIndex?: number;
      nodeId: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.iterationIndex)).toEqual([0, 1]);
    // Same nodeId across iterations is preserved (dedupe is by hash, not nodeId).
    expect(new Set(entries.map((e) => e.nodeId))).toEqual(
      new Set(["transfer-funds-1"])
    );
  });

  it("fallback skips rows whose outputRaw lacks a 0x-prefixed transactionHash", async () => {
    const executionId = "exec_skip_non_tx";
    allLogs = [
      {
        id: "log_with_hash",
        nodeId: "tx-step",
        nodeName: "Tx",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: "0xreal", chainId: 1 },
      },
      {
        id: "log_no_output",
        nodeId: "math-step",
        nodeName: "Math",
        status: "success",
        iterationIndex: null,
        outputRaw: { result: 42 },
      },
      {
        id: "log_null_output",
        nodeId: "noop-step",
        nodeName: "Noop",
        status: "success",
        iterationIndex: null,
        outputRaw: null,
      },
      {
        id: "log_non_string",
        nodeId: "bad-step",
        nodeName: "Bad",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: 12_345 },
      },
      {
        id: "log_no_prefix",
        nodeId: "weird-step",
        nodeName: "Weird",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: "not-a-hash" },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Array<{
      hash: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe("0xreal");
  });

  // KEEP-470: regression guard for the SQL pushdown of the transactionHash
  // prune. The functional tests above filter in JS even when the SQL filter
  // is removed (the mock returns all rows ignoring WHERE), so a typo in the
  // column name, the wrong operator, or accidental removal of the filter
  // would silently pass those tests while regressing performance back to
  // streaming every successful log row through Node.
  it("pushes the transactionHash IS NOT NULL prune into the SQL WHERE clause", async () => {
    const executionId = "exec_sql_filter_shape";
    const findManyMock = vi.mocked(db.query.workflowExecutionLogs.findMany);

    // Trigger the cross-pod fallback path with an empty tracker.
    allLogs = [];
    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    // listTrulyFailedNodes also hits findMany; discriminate by the
    // outputRaw column selector unique to loadHashesFromLogs.
    const loadHashesCall = findManyMock.mock.calls.find(
      ([opts]) =>
        (opts as { columns?: { outputRaw?: boolean } } | undefined)?.columns
          ?.outputRaw === true
    );
    expect(loadHashesCall).toBeDefined();
    const whereJson = JSON.stringify(
      (loadHashesCall?.[0] as { where?: unknown } | undefined)?.where
    );
    // Right column (output_raw, not the double-encoded output) and right
    // operator (IS NOT NULL, not IS NULL). Catches typos and removals.
    expect(whereJson).toContain("output_raw");
    expect(whereJson).toContain("->>'transactionHash' IS NOT NULL");
  });
});

// KEEP-470: the self-heal path (logStepCompleteDb -> late commit flips a
// spurious-error workflow to success) must populate transaction_hashes on the
// same UPDATE. Without this, a cross-pod late commit would leave the row at
// status=success with transaction_hashes=[] even though the run produced hashes.
describe("selfHealWorkflowAfterLateStepCommit transactionHashes (KEEP-470)", () => {
  beforeEach(() => {
    allLogs = [];
    updateCalls = [];
    updateShouldThrow = false;
    mockExecution = null;
    vi.clearAllMocks();
  });

  it("writes transactionHashes when a late step commit flips spurious error to success", async () => {
    const executionId = "exec_self_heal_with_hashes";

    // Workflow was finalized to a spurious error before this step's commit landed.
    mockExecution = {
      status: "error",
      error: "exceeded max retries",
      completedAt: new Date(Date.now() - 5000),
      startedAt: new Date(Date.now() - 30_000),
    };

    // The durable log rows are the cross-pod source of truth for the hash list.
    // (Tracker is empty here because logStepCompleteDb is firing on a different
    // pod than the one that originally ran the step body.)
    allLogs = [
      {
        id: "log_approve",
        nodeId: "approve-1",
        nodeName: "Approve",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xapprove",
          chainId: 1,
          network: "mainnet",
        },
      },
      {
        id: "log_swap",
        nodeId: "swap-1",
        nodeName: "Swap",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xswap",
          chainId: 1,
          network: "mainnet",
        },
      },
    ] as unknown as LogRow[];

    await logStepCompleteDb({
      logId: "log_swap",
      startTime: Date.now() - 1000,
      status: "success",
      outputRaw: {
        transactionHash: "0xswap",
        chainId: 1,
        network: "mainnet",
      },
      executionId,
    });

    // The self-heal UPDATE is the one that flips status to success.
    const healUpdate = updateCalls.find(
      (c) => c.target === workflowExecutionsMock && c.set.status === "success"
    );
    expect(healUpdate).toBeDefined();
    expect(healUpdate?.set.transactionHashes).toEqual([
      {
        hash: "0xapprove",
        nodeId: "approve-1",
        nodeName: "Approve",
        chainId: 1,
        network: "mainnet",
      },
      {
        hash: "0xswap",
        nodeId: "swap-1",
        nodeName: "Swap",
        chainId: 1,
        network: "mainnet",
      },
    ]);
    expect(healUpdate?.set.error).toBeNull();
  });
});
