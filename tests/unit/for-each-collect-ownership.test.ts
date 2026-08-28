/**
 * Regression tests for issue #2157:
 *   "Nested For Each can cross an ancestor loop's Collect boundary (crash
 *    or silent double-fire)"
 *
 * Two topologies from the issue, both against a two-level nesting
 * (for-each-circles outer, for-each-members inner):
 *
 *   Scenario 1 (crash, misleading message): the inner loop's body reaches
 *   both its own Collect and the outer's Collect in one scan. Before this
 *   fix, `identifyLoopBody` threw the generic "multiple in-body Collect
 *   nodes" message, which reads as "you wired two Collects into one loop"
 *   when the real cause is that one belongs to a different, enclosing loop.
 *
 *   Scenario 2 (silent adoption, no error): the inner loop has no Collect of
 *   its own, so its scan resolves `collectNodeId` to the outer's Collect and
 *   returns successfully. Before this fix, nothing caught this.
 *
 * The fix: `identifyLoopBody` takes an optional `claimedCollectOwners` map
 * (Collect node id -> owning forEachNodeId). Both scenarios now throw the
 * same precise ownership error, naming the contested Collect and both
 * loops, the instant the scan reaches an already-claimed Collect. That only
 * gives the right answer if ancestor loops are claimed before their
 * descendants are scanned -- `orderForEachNodesOuterFirst` establishes that
 * order; see the "ordering" describe block below for what goes wrong
 * without it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { buildEdgesBySource } from "@/lib/workflow/executor/convergence-barrier";
import {
  identifyLoopBody,
  orderForEachNodesOuterFirst,
} from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Top-level regex patterns (biome: useTopLevelRegex)
// ---------------------------------------------------------------------------

const OWNERSHIP_REGEX =
  /already belongs to ancestor For Each "for-each-circles"/;
const MULTIPLE_COLLECT_REGEX = /multiple in-body Collect nodes/;

// ---------------------------------------------------------------------------
// Minimal node / edge factory helpers (mirrors for-each-nested-edge-map.test.ts)
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

function buildNodeMap(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

// ---------------------------------------------------------------------------
// Scenario 1: inner body reaches both its own Collect and the ancestor's
//
//   for-each-circles --loop--> for-each-members --loop--> write-cover-default
//   for-each-circles --done--> collect-circles
//   for-each-members --done--> collect-members
//   write-cover-default --> collect-members   (the inner's own)
//   write-cover-default --> collect-circles   (the extra edge -- the bug)
// ---------------------------------------------------------------------------

describe("Scenario 1: inner scan reaches an ancestor's Collect alongside its own", () => {
  const nodes: WorkflowNode[] = [
    makeNode("for-each-circles", "For Each"),
    makeNode("for-each-members", "For Each"),
    makeNode("write-cover-default", "Write Contract"),
    makeNode("collect-members", "Collect"),
    makeNode("collect-circles", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("for-each-circles", "for-each-members", "loop"),
    makeEdge("for-each-circles", "collect-circles", "done"),
    makeEdge("for-each-members", "write-cover-default", "loop"),
    makeEdge("for-each-members", "collect-members", "done"),
    makeEdge("write-cover-default", "collect-members"),
    makeEdge("write-cover-default", "collect-circles"),
  ];
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);

  it("throws the ownership error once the outer Collect is claimed", () => {
    const claimed = new Map<string, string>([
      ["collect-circles", "for-each-circles"],
    ]);

    expect(() =>
      identifyLoopBody(
        "for-each-members",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle,
        claimed
      )
    ).toThrow(OWNERSHIP_REGEX);
  });

  it("falls back to the generic double-Collect message with no ownership context", () => {
    // No claimed map at all -- today's unqualified behavior, unchanged.
    // Both Collects look equally "unowned" from inside this one scan, so the
    // message can only say what it always said.
    expect(() =>
      identifyLoopBody(
        "for-each-members",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      )
    ).toThrow(MULTIPLE_COLLECT_REGEX);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: inner has no Collect of its own, silently adopts the outer's
//
//   for-each-circles --loop--> for-each-members --loop--> write-cover-default
//   for-each-circles --done--> collect-circles
//   write-cover-default --> collect-circles   (inner has no done-handle Collect)
// ---------------------------------------------------------------------------

describe("Scenario 2: inner has no Collect of its own and would silently adopt the outer's", () => {
  const nodes: WorkflowNode[] = [
    makeNode("for-each-circles", "For Each"),
    makeNode("for-each-members", "For Each"),
    makeNode("write-cover-default", "Write Contract"),
    makeNode("collect-circles", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("for-each-circles", "for-each-members", "loop"),
    makeEdge("for-each-circles", "collect-circles", "done"),
    makeEdge("for-each-members", "write-cover-default", "loop"),
    makeEdge("write-cover-default", "collect-circles"),
  ];
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);

  it("resolves collectNodeId to the outer's Collect when unclaimed (pre-fix shape)", () => {
    const innerBody = identifyLoopBody(
      "for-each-members",
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );
    expect(innerBody.collectNodeId).toBe("collect-circles");
  });

  it("throws the ownership error once the outer Collect is claimed", () => {
    const claimed = new Map<string, string>([
      ["collect-circles", "for-each-circles"],
    ]);

    expect(() =>
      identifyLoopBody(
        "for-each-members",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle,
        claimed
      )
    ).toThrow(OWNERSHIP_REGEX);
  });
});

// ---------------------------------------------------------------------------
// Happy path: genuinely separate Collects at each level -- no conflict
// ---------------------------------------------------------------------------

describe("two nested loops with their own Collects: no conflict", () => {
  const nodes: WorkflowNode[] = [
    makeNode("for-each-circles", "For Each"),
    makeNode("for-each-members", "For Each"),
    makeNode("write-cover-default", "Write Contract"),
    makeNode("collect-members", "Collect"),
    makeNode("collect-circles", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("for-each-circles", "for-each-members", "loop"),
    makeEdge("for-each-circles", "collect-circles", "done"),
    makeEdge("for-each-members", "write-cover-default", "loop"),
    makeEdge("for-each-members", "collect-members", "done"),
    makeEdge("write-cover-default", "collect-members"),
  ];
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);

  it("claims each loop's own Collect without throwing when processed outer-first", () => {
    const claimed = new Map<string, string>();
    const outerBody = identifyLoopBody(
      "for-each-circles",
      edgesBySource,
      nodeMap,
      edgesBySourceHandle,
      claimed
    );
    if (outerBody.doneCollectNodeId) {
      claimed.set(outerBody.doneCollectNodeId, "for-each-circles");
    }

    const innerBody = identifyLoopBody(
      "for-each-members",
      edgesBySource,
      nodeMap,
      edgesBySourceHandle,
      claimed
    );

    expect(outerBody.doneCollectNodeId).toBe("collect-circles");
    expect(innerBody.collectNodeId).toBe("collect-members");
  });
});

// ---------------------------------------------------------------------------
// Ordering: outer-before-inner is load-bearing, not incidental
// ---------------------------------------------------------------------------

describe("ordering: the ownership check only works outer-before-inner", () => {
  // Scenario 2's topology again -- inner silently resolves the outer's
  // Collect as its own when nothing has claimed it yet.
  const nodes: WorkflowNode[] = [
    makeNode("for-each-circles", "For Each"),
    makeNode("for-each-members", "For Each"),
    makeNode("write-cover-default", "Write Contract"),
    makeNode("collect-circles", "Collect"),
  ];
  const edges: RawEdge[] = [
    makeEdge("for-each-circles", "for-each-members", "loop"),
    makeEdge("for-each-circles", "collect-circles", "done"),
    makeEdge("for-each-members", "write-cover-default", "loop"),
    makeEdge("write-cover-default", "collect-circles"),
  ];
  const edgesBySource = buildEdgesBySource(edges);
  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
  const nodeMap = buildNodeMap(nodes);

  it("processing the inner loop first mis-claims the outer's Collect with no error", () => {
    const claimed = new Map<string, string>();

    // Inner processed before outer: nothing is claimed yet, so the inner
    // loop's scan resolves collect-circles as its own -- no throw, the
    // exact silent-adoption bug this issue reports.
    const innerBody = identifyLoopBody(
      "for-each-members",
      edgesBySource,
      nodeMap,
      edgesBySourceHandle,
      claimed
    );
    if (innerBody.collectNodeId) {
      claimed.set(innerBody.collectNodeId, "for-each-members");
    }

    expect(innerBody.collectNodeId).toBe("collect-circles");
    expect(claimed.get("collect-circles")).toBe("for-each-members");
  });

  it("orderForEachNodesOuterFirst places the ancestor before its nested loop", () => {
    const ordered = orderForEachNodesOuterFirst(
      ["for-each-members", "for-each-circles"], // deliberately reversed input
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    expect(ordered.indexOf("for-each-circles")).toBeLessThan(
      ordered.indexOf("for-each-members")
    );
  });

  it("processing in that order surfaces the real ownership conflict instead", () => {
    const claimed = new Map<string, string>();
    const ordered = orderForEachNodesOuterFirst(
      ["for-each-members", "for-each-circles"],
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    for (const forEachId of ordered) {
      if (forEachId === "for-each-circles") {
        const outerBody = identifyLoopBody(
          forEachId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle,
          claimed
        );
        if (outerBody.doneCollectNodeId) {
          claimed.set(outerBody.doneCollectNodeId, forEachId);
        }
        continue;
      }

      expect(() =>
        identifyLoopBody(
          forEachId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle,
          claimed
        )
      ).toThrow(OWNERSHIP_REGEX);
    }
  });
});

// ---------------------------------------------------------------------------
// orderForEachNodesOuterFirst: direct coverage beyond the two-level case above
// ---------------------------------------------------------------------------

describe("orderForEachNodesOuterFirst", () => {
  it("keeps independent sibling loops in their given relative order", () => {
    const nodes: WorkflowNode[] = [
      makeNode("fe-a", "For Each"),
      makeNode("fe-b", "For Each"),
      makeNode("collect-a", "Collect"),
      makeNode("collect-b", "Collect"),
    ];
    const edges: RawEdge[] = [
      makeEdge("fe-a", "collect-a", "done"),
      makeEdge("fe-b", "collect-b", "done"),
    ];
    const edgesBySource = buildEdgesBySource(edges);
    const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
    const nodeMap = buildNodeMap(nodes);

    const ordered = orderForEachNodesOuterFirst(
      ["fe-a", "fe-b"],
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    expect(ordered).toEqual(["fe-a", "fe-b"]);
  });

  it("orders 3-level nesting strictly outer to inner regardless of input order", () => {
    const nodes: WorkflowNode[] = [
      makeNode("fe-l1", "For Each"),
      makeNode("fe-l2", "For Each"),
      makeNode("fe-l3", "For Each"),
      makeNode("collect-l1", "Collect"),
      makeNode("collect-l2", "Collect"),
      makeNode("collect-l3", "Collect"),
    ];
    const edges: RawEdge[] = [
      makeEdge("fe-l1", "fe-l2", "loop"),
      makeEdge("fe-l1", "collect-l1", "done"),
      makeEdge("fe-l2", "fe-l3", "loop"),
      makeEdge("fe-l2", "collect-l2", "done"),
      makeEdge("fe-l3", "collect-l3", "done"),
    ];
    const edgesBySource = buildEdgesBySource(edges);
    const edgesBySourceHandle = buildEdgesBySourceHandle(edges);
    const nodeMap = buildNodeMap(nodes);

    const ordered = orderForEachNodesOuterFirst(
      ["fe-l3", "fe-l1", "fe-l2"], // deliberately scrambled
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    expect(ordered).toEqual(["fe-l1", "fe-l2", "fe-l3"]);
  });
});
