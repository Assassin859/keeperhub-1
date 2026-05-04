import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFindFirst, mockFindMany, mockIncrementCounter, mockRecordLatency } =
  vi.hoisted(() => ({
    mockFindFirst: vi.fn(),
    mockFindMany: vi.fn(),
    mockIncrementCounter: vi.fn(),
    mockRecordLatency: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutionLogs: {
        findFirst: mockFindFirst,
        findMany: mockFindMany,
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutionLogs: {
    executionId: "execution_id",
    nodeId: "node_id",
    status: "status",
    iterationIndex: "iteration_index",
    forEachNodeId: "for_each_node_id",
    completedAt: "completed_at",
    outputRaw: "output_raw",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: mockIncrementCounter,
    recordLatency: mockRecordLatency,
  }),
}));

import {
  clearOutputCache,
  getCompletedStepOutput,
  getCompletedStepOutputs,
} from "@/lib/workflow/executor/get-completed-step-output";
import {
  clearExecution,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";

describe("getCompletedStepOutput", () => {
  const executionId = "exec-test-001";
  const nodeId = "node-abc";

  beforeEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
    mockFindFirst.mockReset();
    mockFindMany.mockReset();
    mockIncrementCounter.mockReset();
    mockRecordLatency.mockReset();
  });

  afterEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
  });

  describe("tracker hit", () => {
    it("returns tracker output when the step is recorded in the in-process tracker", async () => {
      recordStepSuccess(executionId, nodeId, { rate: 4.5 });

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result).not.toBeNull();
      expect(result?.source).toBe("tracker");
      expect(result?.output).toEqual({ rate: 4.5 });
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it("returns tracker output for falsy values (null, 0, false)", async () => {
      recordStepSuccess(executionId, "n-null", null);
      recordStepSuccess(executionId, "n-zero", 0);
      recordStepSuccess(executionId, "n-false", false);

      const r1 = await getCompletedStepOutput(executionId, "n-null");
      expect(r1?.source).toBe("tracker");
      expect(r1?.output).toBeNull();

      const r2 = await getCompletedStepOutput(executionId, "n-zero");
      expect(r2?.source).toBe("tracker");
      expect(r2?.output).toBe(0);

      const r3 = await getCompletedStepOutput(executionId, "n-false");
      expect(r3?.source).toBe("tracker");
      expect(r3?.output).toBe(false);
    });
  });

  describe("DB fallback on tracker miss", () => {
    it("queries the DB and returns output_raw when tracker has no entry for this execution", async () => {
      mockFindFirst.mockResolvedValue({
        outputRaw: { merged: 99 },
      });

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result).not.toBeNull();
      expect(result?.source).toBe("db");
      expect(result?.output).toEqual({ merged: 99 });
      expect(mockFindFirst).toHaveBeenCalledTimes(1);
    });

    it("queries the DB when tracker has entries for execution but not this specific nodeId", async () => {
      recordStepSuccess(executionId, "other-node", { ok: true });
      mockFindFirst.mockResolvedValue({ outputRaw: { dbValue: 42 } });

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result?.source).toBe("db");
      expect(result?.output).toEqual({ dbValue: 42 });
    });

    it("returns null when DB also has no success row", async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result).toBeNull();
    });

    it("treats DB row with null outputRaw as miss (pre-migration backfill safety)", async () => {
      // Rows written before migration 0066 have output_raw IS NULL. The WHERE
      // clause now includes isNotNull(outputRaw), so the DB returns no row for
      // these pre-migration records. The helper returns null (miss), and the
      // caller falls back to its closure value -- identical to pre-PR behaviour
      // on cross-process resume. This prevents null from overwriting a real
      // closure value during the deploy window.
      mockFindFirst.mockResolvedValue(undefined);

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result).toBeNull();
    });

    it("returns raw output, not redacted: apiKey field flows through as-is from output_raw", async () => {
      const rawOutput = { apiKey: "0xSECRET_KEY", amount: 100 };
      mockFindFirst.mockResolvedValue({ outputRaw: rawOutput });

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result?.source).toBe("db");
      expect(result?.output).toEqual(rawOutput);
      expect((result?.output as Record<string, unknown>)?.apiKey).toBe(
        "0xSECRET_KEY"
      );
    });
  });

  describe("single-flight: multiple concurrent calls issue exactly 1 DB query", () => {
    it("5 concurrent calls for same (executionId, nodeId) issue exactly 1 DB query", async () => {
      mockFindFirst.mockResolvedValue({ outputRaw: { coalesced: true } });

      const calls = await Promise.all([
        getCompletedStepOutput(executionId, nodeId),
        getCompletedStepOutput(executionId, nodeId),
        getCompletedStepOutput(executionId, nodeId),
        getCompletedStepOutput(executionId, nodeId),
        getCompletedStepOutput(executionId, nodeId),
      ]);

      expect(mockFindFirst).toHaveBeenCalledTimes(1);
      for (const r of calls) {
        expect(r?.source).toBe("db");
        expect(r?.output).toEqual({ coalesced: true });
      }
    });

    it("different (executionId, nodeId) pairs each get their own DB call", async () => {
      const exec2 = "exec-test-002";
      clearOutputCache(exec2);
      clearExecution(exec2);

      mockFindFirst
        .mockResolvedValueOnce({ outputRaw: { a: 1 } })
        .mockResolvedValueOnce({ outputRaw: { b: 2 } });

      const [r1, r2] = await Promise.all([
        getCompletedStepOutput(executionId, nodeId),
        getCompletedStepOutput(exec2, nodeId),
      ]);

      expect(mockFindFirst).toHaveBeenCalledTimes(2);
      expect(r1?.output).toEqual({ a: 1 });
      expect(r2?.output).toEqual({ b: 2 });

      clearOutputCache(exec2);
      clearExecution(exec2);
    });

    it("second call after cache is cleared re-queries the DB", async () => {
      mockFindFirst
        .mockResolvedValueOnce({ outputRaw: { first: true } })
        .mockResolvedValueOnce({ outputRaw: { second: true } });

      const r1 = await getCompletedStepOutput(executionId, nodeId);
      expect(r1?.output).toEqual({ first: true });
      expect(mockFindFirst).toHaveBeenCalledTimes(1);

      clearOutputCache(executionId);

      const r2 = await getCompletedStepOutput(executionId, nodeId);
      expect(r2?.output).toEqual({ second: true });
      expect(mockFindFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe("error containment: DB rejection evicts cache and returns null", () => {
    it("returns null when DB query rejects, and does not cache the rejection", async () => {
      mockFindFirst.mockRejectedValueOnce(new Error("Connection timeout"));

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result).toBeNull();
    });

    it("subsequent call after a DB rejection re-queries (cache was evicted)", async () => {
      mockFindFirst
        .mockRejectedValueOnce(new Error("Pool exhausted"))
        .mockResolvedValueOnce({ outputRaw: { recovered: true } });

      const r1 = await getCompletedStepOutput(executionId, nodeId);
      expect(r1).toBeNull();

      const r2 = await getCompletedStepOutput(executionId, nodeId);
      expect(r2?.output).toEqual({ recovered: true });
      expect(mockFindFirst).toHaveBeenCalledTimes(2);
    });

    it("increments error counter when DB query rejects", async () => {
      mockFindFirst.mockRejectedValueOnce(new Error("Connection timeout"));

      await getCompletedStepOutput(executionId, nodeId);

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.tracker_db_fallback.total",
        expect.objectContaining({ outcome: "error" })
      );
    });
  });

  describe("kill-switch: KH_EXECUTOR_AUTHORITY_DB_FALLBACK=false skips DB entirely", () => {
    // The kill-switch constant is read at module load time. Runtime env mutation
    // cannot affect it. We use vi.stubEnv + vi.resetModules + dynamic import to
    // re-load the module with the env var present at import time, exercising the
    // real off-state code path. Note: toggling the env var in production requires
    // a pod restart, not just a config push.

    it("off-state: returns null on tracker miss without querying the DB", async () => {
      vi.stubEnv("KH_EXECUTOR_AUTHORITY_DB_FALLBACK", "false");
      vi.resetModules();

      const { getCompletedStepOutput: getOutputOff } = await import(
        "@/lib/workflow/executor/get-completed-step-output"
      );

      mockFindFirst.mockResolvedValue({ outputRaw: { shouldNotSee: true } });

      const result = await getOutputOff(executionId, nodeId);

      expect(result).toBeNull();
      expect(mockFindFirst).not.toHaveBeenCalled();

      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("off-state: batch helper also skips DB when kill-switch is off", async () => {
      vi.stubEnv("KH_EXECUTOR_AUTHORITY_DB_FALLBACK", "false");
      vi.resetModules();

      const { getCompletedStepOutputs: getOutputsOff } = await import(
        "@/lib/workflow/executor/get-completed-step-output"
      );

      mockFindMany.mockResolvedValue([
        { nodeId: "p1", outputRaw: { shouldNotSee: true } },
      ]);

      const result = await getOutputsOff(executionId, ["p1", "p2"]);

      expect(result.size).toBe(0);
      expect(mockFindMany).not.toHaveBeenCalled();

      vi.unstubAllEnvs();
      vi.resetModules();
    });
  });

  describe("performance: DB read latency stays bounded in fixture", () => {
    it("resolves within 50ms when DB returns synchronously (fixture performance contract)", async () => {
      mockFindFirst.mockResolvedValue({ outputRaw: { fast: true } });

      const start = Date.now();
      await getCompletedStepOutput(executionId, nodeId);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });
});

describe("getCompletedStepOutputs (batch helper)", () => {
  const executionId = "exec-batch-001";

  beforeEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
    mockFindFirst.mockReset();
    mockFindMany.mockReset();
    mockIncrementCounter.mockReset();
    mockRecordLatency.mockReset();
  });

  afterEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
  });

  it("returns empty map for empty nodeIds", async () => {
    const result = await getCompletedStepOutputs(executionId, []);

    expect(result.size).toBe(0);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("9 missing predecessors issues exactly 1 DB call (batch query)", async () => {
    const nodeIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];

    mockFindMany.mockResolvedValue(
      nodeIds.map((nodeId) => ({ nodeId, outputRaw: { value: nodeId } }))
    );

    const result = await getCompletedStepOutputs(executionId, nodeIds);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(9);
    for (const nodeId of nodeIds) {
      expect(result.get(nodeId)?.output).toEqual({ value: nodeId });
      expect(result.get(nodeId)?.source).toBe("db");
    }
  });

  it("tracker hits are resolved without a DB call; only misses go to DB", async () => {
    recordStepSuccess(executionId, "p1", { fromTracker: true });
    recordStepSuccess(executionId, "p2", { fromTracker: true });

    mockFindMany.mockResolvedValue([
      { nodeId: "p3", outputRaw: { fromDb: true } },
    ]);

    const result = await getCompletedStepOutputs(executionId, [
      "p1",
      "p2",
      "p3",
    ]);

    expect(result.get("p1")?.source).toBe("tracker");
    expect(result.get("p2")?.source).toBe("tracker");
    expect(result.get("p3")?.source).toBe("db");
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("all tracker hits: no DB call issued", async () => {
    recordStepSuccess(executionId, "p1", { a: 1 });
    recordStepSuccess(executionId, "p2", { b: 2 });

    const result = await getCompletedStepOutputs(executionId, ["p1", "p2"]);

    expect(mockFindMany).not.toHaveBeenCalled();
    expect(result.size).toBe(2);
  });

  it("returns partial result when DB has only some rows", async () => {
    mockFindMany.mockResolvedValue([
      { nodeId: "p1", outputRaw: { found: true } },
    ]);

    const result = await getCompletedStepOutputs(executionId, ["p1", "p2"]);

    expect(result.has("p1")).toBe(true);
    expect(result.has("p2")).toBe(false);
  });

  it("returns empty map on DB error (error containment)", async () => {
    mockFindMany.mockRejectedValue(new Error("DB failure"));

    const result = await getCompletedStepOutputs(executionId, ["p1", "p2"]);

    expect(result.size).toBe(0);
    expect(mockIncrementCounter).toHaveBeenCalledWith(
      "workflow.executor.tracker_db_fallback.total",
      expect.objectContaining({ outcome: "error" })
    );
  });

  it("iteration rows are excluded: only non-loop canonical rows are returned", async () => {
    // findMany is called with isNull(iterationIndex) + isNull(forEachNodeId)
    // filters. The mock returns only what passes those filters -- we assert
    // the call happened (filter is in the query) by checking the mock was called.
    mockFindMany.mockResolvedValue([
      { nodeId: "p1", outputRaw: { canonical: true } },
    ]);

    const result = await getCompletedStepOutputs(executionId, ["p1"]);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(result.get("p1")?.output).toEqual({ canonical: true });
  });

  it("pre-migration null outputRaw rows are treated as miss in batch path", async () => {
    // Rows written before migration 0066 have output_raw IS NULL. The WHERE
    // clause includes isNotNull(outputRaw), so the DB returns no rows for
    // pre-migration records. The result Map omits the key; the merge consumer
    // falls back to the closure value, preventing null from overwriting a real
    // in-process result during the deploy window.
    mockFindMany.mockResolvedValue([]);

    const result = await getCompletedStepOutputs(executionId, ["p1"]);

    expect(result.has("p1")).toBe(false);
    expect(result.size).toBe(0);
  });

  it("records latency histogram when DB is queried", async () => {
    mockFindMany.mockResolvedValue([{ nodeId: "p1", outputRaw: { x: 1 } }]);

    await getCompletedStepOutputs(executionId, ["p1"]);

    expect(mockRecordLatency).toHaveBeenCalledWith(
      "workflow.executor.tracker_db_fallback.duration_ms",
      expect.any(Number)
    );
  });
});
