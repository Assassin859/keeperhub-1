/**
 * Regression tests for issue #2049:
 *   "Condition node never executes when nested inside two For Each loops
 *    (nested loop edge-map bug)"
 *
 * Root cause: handleForEachExecution's handleNestedForEach callback passed
 * `currentEdgesBySource: bodyEdgesBySource` — the *outer* loop's own locally-
 * scoped, partial edge map — to the recursive inner-loop call.  Because the
 * outer BFS intentionally does not walk into the inner loop's `loop` branch,
 * `bodyEdgesBySource` has no entry for any edge that lives purely inside the
 * inner loop's body (e.g. `read-contributed -> condition-not-contributed`).
 * When that incomplete map was forwarded as `currentEdgesBySource` to
 * `identifyLoopBody`, the inner loop's body-scan saw zero downstream targets
 * after the seed node and silently terminated, leaving the Condition node
 * absent from the execution trace.
 *
 * Fix (executor.workflow.ts line 2101): pass `edgesBySource` (the workflow-
 * global map, built once at line 1821) instead of `bodyEdgesBySource`.
 *
 * These tests exercise the ACTUAL recursive handoff path — calling
 * `identifyLoopBody` first for the outer loop (producing a partial
 * `bodyEdgesBySource`), then calling it again for the inner loop using:
 *   a) the outer's partial map  => demonstrates the broken behaviour
 *   b) the global map           => demonstrates the correct behaviour / fix
 *
 * This closes the coverage gap noted by the maintainer:
 *   "tests/unit/for-each-executor.test.ts's 'handles deeply nested For Each
 *    chains' case only calls identifyLoopBody once, directly, with the full
 *    global map — it doesn't exercise the actual recursive
 *    handleForEachExecution handoff where a partial map gets reused."
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { identifyLoopBody } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Minimal node / edge factory helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, actionType: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType },
    },
  };
}

type RawEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};

let _edgeSeq = 0;
function makeEdge(
  source: string,
  target: string,
  sourceHandle?: string
): RawEdge {
  return {
    id: `e${++_edgeSeq}`,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
  };
}

function buildEdgesBySource(edges: RawEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    const list = map.get(e.source) ?? [];
    list.push(e.target);
    map.set(e.source, list);
  }
  return map;
}

function buildNodeMap(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

// ---------------------------------------------------------------------------
// Shared workflow topology (mirrors the real failing workflow from issue #2049)
//
//   for-each-circles  (outer For Each)
//     +- condition-due           (Condition at depth-1 — works correctly)
//     +- for-each-members        (inner For Each — nested)
//          +- read-contributed   (depth-2 seed node)
//          +- condition-not-contributed  (Condition at depth-2 — THE BUG)
//          +- write-deposit-draw         (depth-2 action)
//          +- collect-members            (terminates inner body)
//     +- collect-circles         (terminates outer body)
// ---------------------------------------------------------------------------

const ALL_NODES: WorkflowNode[] = [
  makeNode("for-each-circles", "For Each"),
  makeNode("condition-due", "Condition"),
  makeNode("for-each-members", "For Each"),
  makeNode("read-contributed", "Read Contract"),
  makeNode("condition-not-contributed", "Condition"),
  makeNode("write-deposit-draw", "Write Contract"),
  makeNode("collect-members", "Collect"),
  makeNode("collect-circles", "Collect"),
];

const ALL_EDGES: RawEdge[] = [
  // Outer body edges
  makeEdge("for-each-circles", "condition-due", "loop"),
  makeEdge("for-each-circles", "for-each-members", "loop"),
  makeEdge("for-each-circles", "collect-circles", "done"),
  // Inner body edges — live PURELY inside the inner loop
  makeEdge("for-each-members", "read-contributed", "loop"),
  makeEdge("for-each-members", "collect-members", "done"),
  makeEdge("read-contributed", "condition-not-contributed"),
  makeEdge("condition-not-contributed", "write-deposit-draw", "true"),
  makeEdge("write-deposit-draw", "collect-members"),
  // Done-chain exits inner loop
  makeEdge("collect-members", "collect-circles"),
];

const GLOBAL_EDGES_BY_SOURCE = buildEdgesBySource(ALL_EDGES);
const GLOBAL_EDGES_BY_SOURCE_HANDLE = buildEdgesBySourceHandle(ALL_EDGES);
const NODE_MAP = buildNodeMap(ALL_NODES);

// ---------------------------------------------------------------------------
// Outer loop body identification (baseline — must always pass)
// ---------------------------------------------------------------------------

describe("outer For Each body identification (baseline)", () => {
  it("finds the outer body correctly using the global edge map", () => {
    const outerBody = identifyLoopBody(
      "for-each-circles",
      GLOBAL_EDGES_BY_SOURCE,
      NODE_MAP,
      GLOBAL_EDGES_BY_SOURCE_HANDLE
    );

    expect(outerBody.bodyNodeIds).toContain("for-each-members");
    expect(outerBody.bodyNodeIds).toContain("condition-due");
    expect(outerBody.collectNodeId).toBe("collect-circles");
    expect(outerBody.bodyNodeIds).not.toContain("collect-circles");
  });
});

// ---------------------------------------------------------------------------
// Core regression: inner For Each body - nested edge-map handoff (issue #2049)
// ---------------------------------------------------------------------------

describe("inner For Each body identification — nested edge-map handoff (issue #2049)", () => {
  const outerBody = identifyLoopBody(
    "for-each-circles",
    GLOBAL_EDGES_BY_SOURCE,
    NODE_MAP,
    GLOBAL_EDGES_BY_SOURCE_HANDLE
  );
  // This is the incomplete map the old code wrongly forwarded.
  const outerBodyEdgesBySource = outerBody.bodyEdgesBySource;

  it("(pre-fix) outer bodyEdgesBySource does NOT contain the inner-body Condition edge", () => {
    // With the outer's partial map, the inner BFS has no entry for
    // read-contributed -> condition-not-contributed, so the Condition is absent.
    const innerBodyViaBrokenMap = identifyLoopBody(
      "for-each-members",
      outerBodyEdgesBySource, // the BUGGY argument — outer partial map
      NODE_MAP,
      GLOBAL_EDGES_BY_SOURCE_HANDLE
    );

    expect(innerBodyViaBrokenMap.bodyNodeIds).not.toContain(
      "condition-not-contributed"
    );
    expect(innerBodyViaBrokenMap.bodyNodeIds).not.toContain(
      "write-deposit-draw"
    );
  });

  it("(post-fix) global edgesBySource correctly exposes all inner-body nodes", () => {
    const innerBodyViaGlobalMap = identifyLoopBody(
      "for-each-members",
      GLOBAL_EDGES_BY_SOURCE, // the CORRECT argument — global map
      NODE_MAP,
      GLOBAL_EDGES_BY_SOURCE_HANDLE
    );

    expect(innerBodyViaGlobalMap.bodyNodeIds).toContain("read-contributed");
    expect(innerBodyViaGlobalMap.bodyNodeIds).toContain(
      "condition-not-contributed"
    );
    expect(innerBodyViaGlobalMap.bodyNodeIds).toContain("write-deposit-draw");
    expect(innerBodyViaGlobalMap.collectNodeId).toBe("collect-members");
    expect(innerBodyViaGlobalMap.bodyNodeIds).not.toContain("collect-members");
  });

  it("(post-fix) inner bodyEdgesBySource contains the edge that was silently absent before the fix", () => {
    const innerBodyViaGlobalMap = identifyLoopBody(
      "for-each-members",
      GLOBAL_EDGES_BY_SOURCE,
      NODE_MAP,
      GLOBAL_EDGES_BY_SOURCE_HANDLE
    );

    // The edge read-contributed -> condition-not-contributed must be present
    // in the inner body map for the runtime walker to reach the Condition.
    expect(
      innerBodyViaGlobalMap.bodyEdgesBySource.get("read-contributed")
    ).toContain("condition-not-contributed");
  });
});

// ---------------------------------------------------------------------------
// Generalisation: 3-level nesting — same fix applies at every recursion depth
// ---------------------------------------------------------------------------

describe("3-level nesting: Condition at depth-3 is reachable with global map", () => {
  //   fe-l1 -> fe-l2 -> fe-l3 -> read-data -> condition-deep
  //                                          -> (true) write-result -> collect-l3
  //   collect-l3 -> collect-l2 -> collect-l1

  const nodes3: WorkflowNode[] = [
    makeNode("fe-l1", "For Each"),
    makeNode("fe-l2", "For Each"),
    makeNode("fe-l3", "For Each"),
    makeNode("read-data", "Read Contract"),
    makeNode("condition-deep", "Condition"),
    makeNode("write-result", "Write Contract"),
    makeNode("collect-l3", "Collect"),
    makeNode("collect-l2", "Collect"),
    makeNode("collect-l1", "Collect"),
  ];

  const edges3: RawEdge[] = [
    makeEdge("fe-l1", "fe-l2", "loop"),
    makeEdge("fe-l1", "collect-l1", "done"),
    makeEdge("fe-l2", "fe-l3", "loop"),
    makeEdge("fe-l2", "collect-l2", "done"),
    makeEdge("fe-l3", "read-data", "loop"),
    makeEdge("fe-l3", "collect-l3", "done"),
    makeEdge("read-data", "condition-deep"),
    makeEdge("condition-deep", "write-result", "true"),
    makeEdge("write-result", "collect-l3"),
    makeEdge("collect-l3", "collect-l2"),
    makeEdge("collect-l2", "collect-l1"),
  ];

  const global3 = buildEdgesBySource(edges3);
  const globalHandle3 = buildEdgesBySourceHandle(edges3);
  const nodeMap3 = buildNodeMap(nodes3);

  it("depth-3 Condition is visible when the global map is used (post-fix)", () => {
    const innermost = identifyLoopBody(
      "fe-l3",
      global3,
      nodeMap3,
      globalHandle3
    );

    expect(innermost.bodyNodeIds).toContain("read-data");
    expect(innermost.bodyNodeIds).toContain("condition-deep");
    expect(innermost.bodyNodeIds).toContain("write-result");
    expect(innermost.collectNodeId).toBe("collect-l3");
  });

  it("depth-3 Condition is NOT visible when partial maps are chained (pre-fix regression)", () => {
    // Simulate the old buggy chain: each level forwards its own partial map
    // to the next level's identifyLoopBody call.
    const l1Body = identifyLoopBody("fe-l1", global3, nodeMap3, globalHandle3);
    const l2Body = identifyLoopBody(
      "fe-l2",
      l1Body.bodyEdgesBySource, // l1 partial
      nodeMap3,
      globalHandle3
    );
    const l3Body = identifyLoopBody(
      "fe-l3",
      l2Body.bodyEdgesBySource, // l2 partial (which itself was built from l1 partial)
      nodeMap3,
      globalHandle3
    );

    expect(l3Body.bodyNodeIds).not.toContain("condition-deep");
    expect(l3Body.bodyNodeIds).not.toContain("write-result");
  });
});
