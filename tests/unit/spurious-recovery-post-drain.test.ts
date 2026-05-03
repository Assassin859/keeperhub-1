/**
 * KEEP-398: Post-drain reconciliation pass.
 *
 * Tests the post-drain reconciler that runs after pendingTasks.drain() and
 * before computeFinalSuccess. When a result entry matches the spurious
 * max-retries error pattern AND a success row exists in workflow_execution_logs,
 * the failed entry is overridden to success and the spurious_recovery counter
 * is incremented.
 *
 * The reconciler is imported as a standalone function so it can be unit-tested
 * without spinning up the full executor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFindFirst, mockIncrementCounter } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockIncrementCounter: vi.fn(),
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

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: mockIncrementCounter,
  }),
}));

import { clearOutputCache } from "@/lib/workflow/executor/get-completed-step-output";
import type { ExecutionResult } from "@/lib/workflow/executor/spurious-recovery";
import { reconcileSpuriousFailures } from "@/lib/workflow/executor/spurious-recovery";
import {
  clearExecution,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";

describe("reconcileSpuriousFailures (KEEP-398 post-drain pass)", () => {
  const executionId = "exec-keep-398-post-drain";
  const nodeId = "combine-node-1";

  beforeEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
    mockFindFirst.mockReset();
    mockIncrementCounter.mockReset();
  });

  afterEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
  });

  describe("in-catch fast-path: tracker already populated (20% case)", () => {
    it("overrides failed result from tracker when error matches spurious shape", async () => {
      recordStepSuccess(executionId, nodeId, { merged: 42 });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
      expect(results[nodeId].data).toEqual({ merged: 42 });
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.spurious_recovery.total",
        expect.anything()
      );
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it("overrides for 'failed after N retries' shape", async () => {
      recordStepSuccess(executionId, nodeId, { ok: true });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "combine" failed after 0 retries: state replay mismatch',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
    });

    it("overrides for 'Step did not record completion' shape", async () => {
      recordStepSuccess(executionId, nodeId, { result: 99 });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: "Step did not record completion within timeout window",
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
    });
  });

  describe("prod KEEP-398 repro: tracker empty, DB has success row", () => {
    it("overrides failed result from DB when tracker is empty but DB row exists", async () => {
      mockFindFirst.mockResolvedValue({ output: { mergedFromDb: true } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
      expect(results[nodeId].data).toEqual({ mergedFromDb: true });
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.spurious_recovery.total",
        expect.anything()
      );
    });

    it("increments counter exactly once per recovered node", async () => {
      mockFindFirst.mockResolvedValue({ output: { x: 1 } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(mockIncrementCounter).toHaveBeenCalledTimes(1);
    });

    it("recovers multiple failed nodes in the same pass", async () => {
      const nodeB = "combine-node-2";
      mockFindFirst.mockResolvedValue({ output: { db: true } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
        [nodeB]: {
          success: false,
          error: "Step did not record completion within timeout window",
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
      expect(results[nodeB].success).toBe(true);
      expect(mockIncrementCounter).toHaveBeenCalledTimes(2);
    });
  });

  describe("negative: failed entry stands when no success evidence exists", () => {
    it("does not override when DB has no success row for the node", async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(false);
      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });

    it("does not override for unrelated errors even when DB has a success row", async () => {
      mockFindFirst.mockResolvedValue({ output: { ok: true } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: "Contract reverted: insufficient balance",
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(false);
      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });

    it("does not modify already-successful entries", async () => {
      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: true,
          data: { alreadyGood: true },
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
      expect(results[nodeId].data).toEqual({ alreadyGood: true });
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });

    it("does not reconcile when executionId is undefined", async () => {
      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId: undefined, results });

      expect(results[nodeId].success).toBe(false);
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });

    it("does not modify the counter when results object is empty", async () => {
      const results: Record<string, ExecutionResult> = {};

      await reconcileSpuriousFailures({ executionId, results });

      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });
  });
});
