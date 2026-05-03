/**
 * KEEP-395: Cross-process convergence merge authority.
 *
 * Tests that `mergeFromAuthority` correctly falls back to the DB when the
 * in-process step-success-tracker is empty (simulating a cross-pod SDK resume
 * where predecessors ran on a different worker process).
 *
 * The in-process tracker is cleared between "predecessor completion" and the
 * convergence merge to simulate the prod cross-process boundary.
 */

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
  mergeFromAuthority,
  type NodeOutputs,
} from "@/lib/workflow/executor/convergence-tracker-merge";
import { clearOutputCache } from "@/lib/workflow/executor/get-completed-step-output";
import {
  clearExecution,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";
import type { WorkflowNode } from "@/lib/workflow/store";

function makeNode(id: string, label?: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: label ?? id,
      config: {},
    },
  } as unknown as WorkflowNode;
}

const getNodeName = (n: WorkflowNode): string =>
  (n.data.label as string) ?? n.id;

describe("mergeFromAuthority (KEEP-395 cross-process DB fallback)", () => {
  const executionId = "exec-keep-395-authority";

  beforeEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
    mockFindFirst.mockReset();
  });

  afterEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
  });

  it("returns original outputs unchanged when executionId is undefined", async () => {
    const outputs: NodeOutputs = { a: { label: "A", data: 1 } };

    const result = await mergeFromAuthority({
      outputs,
      executionId: undefined,
      predecessorIds: ["a"],
      nodeMap: new Map([["a", makeNode("a")]]),
      getNodeName,
    });

    expect(result).toBe(outputs);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("returns original outputs unchanged when predecessorIds is empty", async () => {
    const outputs: NodeOutputs = { a: { label: "A", data: 1 } };

    const result = await mergeFromAuthority({
      outputs,
      executionId,
      predecessorIds: [],
      nodeMap: new Map([["a", makeNode("a")]]),
      getNodeName,
    });

    expect(result).toBe(outputs);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  describe("fast path: tracker hit (same process)", () => {
    it("uses tracker data without querying DB when tracker has the predecessor", async () => {
      recordStepSuccess(executionId, "predA", { rate: 4.5 });

      const outputs: NodeOutputs = {
        predA: { label: "A", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["predA"],
        nodeMap: new Map([["predA", makeNode("predA", "A")]]),
        getNodeName,
      });

      expect(result.predA.data).toEqual({ rate: 4.5 });
      expect(mockFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("DB authority: cross-process resume simulation", () => {
    it("prod KEEP-395 repro: 9-fan-in, tracker empty, DB returns all 9 predecessor outputs", async () => {
      const predIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
      const nodeMap = new Map(predIds.map((id) => [id, makeNode(id)]));

      const outputs: NodeOutputs = Object.fromEntries(
        predIds.map((id) => [id, { label: id, data: null }])
      );

      // Simulate all 9 predecessors in DB (no tracker entries -- cross-process)
      mockFindFirst.mockImplementation(() =>
        Promise.resolve({ output: { value: "result-for-db" } })
      );

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: predIds,
        nodeMap,
        getNodeName,
      });

      for (const id of predIds) {
        expect(result[id].data).toEqual({ value: "result-for-db" });
        expect(result[id].data).not.toBeNull();
      }
    });

    it("stale closure null is overridden by DB output for the missing predecessor", async () => {
      // Tracker is empty (cross-process). DB has the success row.
      mockFindFirst.mockResolvedValue({ output: { sparkPos: 1234 } });

      const outputs: NodeOutputs = {
        sparkPosOut: { label: "Spark Pos", data: null },
        otherPred: { label: "Other", data: { ok: true } },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["sparkPosOut", "otherPred"],
        nodeMap: new Map([
          ["sparkPosOut", makeNode("sparkPosOut", "Spark Pos")],
          ["otherPred", makeNode("otherPred", "Other")],
        ]),
        getNodeName,
      });

      expect(result.sparkPosOut.data).toEqual({ sparkPos: 1234 });
    });

    it("partial cross-process: tracker has some, DB fills the rest", async () => {
      const predIds = ["pA", "pB", "pC"];
      const nodeMap = new Map(predIds.map((id) => [id, makeNode(id)]));

      // pA is in tracker (same-process predecessor)
      recordStepSuccess(executionId, "pA", { fromTracker: true });

      // pB and pC are only in DB (cross-process predecessors)
      mockFindFirst.mockResolvedValue({ output: { fromDb: true } });

      const outputs: NodeOutputs = {
        pA: { label: "pA", data: null },
        pB: { label: "pB", data: null },
        pC: { label: "pC", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: predIds,
        nodeMap,
        getNodeName,
      });

      expect(result.pA.data).toEqual({ fromTracker: true });
      expect(result.pB.data).toEqual({ fromDb: true });
      expect(result.pC.data).toEqual({ fromDb: true });
    });
  });

  describe("negative: DB also has no success row", () => {
    it("closure value stands when both tracker and DB miss", async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const closureValue = { staleButOnlyValue: true };
      const outputs: NodeOutputs = {
        pred: { label: "P", data: closureValue },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["pred"],
        nodeMap: new Map([["pred", makeNode("pred", "P")]]),
        getNodeName,
      });

      expect(result.pred.data).toBe(closureValue);
    });

    it("returns original outputs object (identity) when no merge occurred", async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const outputs: NodeOutputs = {
        pred: { label: "P", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["pred"],
        nodeMap: new Map([["pred", makeNode("pred", "P")]]),
        getNodeName,
      });

      expect(result).toBe(outputs);
    });
  });

  describe("sanitised node IDs", () => {
    it("produces sanitised key in merged result for IDs with dashes and dots", async () => {
      const rawId = "node-with-dashes.and.dots";
      const sanitized = "node_with_dashes_and_dots";

      mockFindFirst.mockResolvedValue({ output: { dbResult: true } });

      const outputs: NodeOutputs = {
        [sanitized]: { label: "raw", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: [rawId],
        nodeMap: new Map([[rawId, makeNode(rawId, "raw")]]),
        getNodeName,
      });

      expect(result[sanitized].data).toEqual({ dbResult: true });
    });
  });
});
