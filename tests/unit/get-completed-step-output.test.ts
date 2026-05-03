import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutionLogs: {
        findFirst: mockFindFirst,
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutionLogs: {
    executionId: "execution_id",
    nodeId: "node_id",
    status: "status",
  },
}));

import {
  clearOutputCache,
  getCompletedStepOutput,
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
    it("queries the DB when tracker has no entry for this execution", async () => {
      mockFindFirst.mockResolvedValue({
        output: { merged: 99 },
      });

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result).not.toBeNull();
      expect(result?.source).toBe("db");
      expect(result?.output).toEqual({ merged: 99 });
      expect(mockFindFirst).toHaveBeenCalledTimes(1);
    });

    it("queries the DB when tracker has entries for execution but not this specific nodeId", async () => {
      recordStepSuccess(executionId, "other-node", { ok: true });
      mockFindFirst.mockResolvedValue({ output: { dbValue: 42 } });

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result?.source).toBe("db");
      expect(result?.output).toEqual({ dbValue: 42 });
    });

    it("returns null when DB also has no success row", async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result).toBeNull();
    });

    it("returns null when DB returns a row with null output (not yet completed)", async () => {
      mockFindFirst.mockResolvedValue(null);

      const result = await getCompletedStepOutput(executionId, nodeId);

      expect(result).toBeNull();
    });
  });

  describe("single-flight: multiple concurrent calls issue exactly 1 DB query", () => {
    it("5 concurrent calls for same (executionId, nodeId) issue exactly 1 DB query", async () => {
      mockFindFirst.mockResolvedValue({ output: { coalesced: true } });

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
        .mockResolvedValueOnce({ output: { a: 1 } })
        .mockResolvedValueOnce({ output: { b: 2 } });

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
        .mockResolvedValueOnce({ output: { first: true } })
        .mockResolvedValueOnce({ output: { second: true } });

      const r1 = await getCompletedStepOutput(executionId, nodeId);
      expect(r1?.output).toEqual({ first: true });
      expect(mockFindFirst).toHaveBeenCalledTimes(1);

      clearOutputCache(executionId);

      const r2 = await getCompletedStepOutput(executionId, nodeId);
      expect(r2?.output).toEqual({ second: true });
      expect(mockFindFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe("performance: DB read latency stays bounded in fixture", () => {
    it("resolves within 50ms when DB returns synchronously (fixture performance contract)", async () => {
      mockFindFirst.mockResolvedValue({ output: { fast: true } });

      const start = Date.now();
      await getCompletedStepOutput(executionId, nodeId);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });
});
