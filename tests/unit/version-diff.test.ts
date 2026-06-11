import { describe, expect, it, vi } from "vitest";

// version-diff pulls in step-registry, which `import "server-only"`. That guard
// throws under vitest (no SSR context), so stub it.
vi.mock("server-only", () => ({}));

import { computeVersionDiff } from "@/lib/workflow/version-diff";

const node = (id: string, label: string, config: object = {}) => ({
  id,
  type: "default",
  position: { x: 0, y: 0 },
  data: { type: "action", label, config },
});

describe("computeVersionDiff", () => {
  it("reports no changes for a position-only (cosmetic) move", () => {
    const before = { nodes: [node("n1", "A")], edges: [] };
    const after = {
      nodes: [{ ...node("n1", "A"), position: { x: 999, y: 42 } }],
      edges: [],
    };
    expect(computeVersionDiff(before, after).hasChanges).toBe(false);
  });

  it("detects an added node with its type", () => {
    const before = { nodes: [node("n1", "A")], edges: [] };
    const after = { nodes: [node("n1", "A"), node("n2", "B")], edges: [] };
    const diff = computeVersionDiff(before, after);
    expect(diff.nodesAdded).toEqual([
      { id: "n2", label: "B", nodeType: "action" },
    ]);
    expect(diff.hasChanges).toBe(true);
  });

  it("captures a renamed node with before/after label", () => {
    const before = { nodes: [node("n1", "Old")], edges: [] };
    const after = { nodes: [node("n1", "New")], edges: [] };
    const changed = computeVersionDiff(before, after).nodesChanged;
    expect(changed).toHaveLength(1);
    expect(changed[0].nodeType).toBe("action");
    expect(changed[0].deltas).toContainEqual({
      field: "name",
      before: "Old",
      after: "New",
    });
  });

  it("lists changed config keys", () => {
    const before = { nodes: [node("n1", "A", { amount: 1 })], edges: [] };
    const after = { nodes: [node("n1", "A", { amount: 2 })], edges: [] };
    const delta = computeVersionDiff(before, after).nodesChanged[0].deltas[0];
    expect(delta.field).toBe("configuration");
    expect(delta.configKeys).toEqual(["amount"]);
  });

  it("detects added and removed connections with node labels", () => {
    const before = {
      nodes: [node("n1", "Trigger"), node("n2", "Send")],
      edges: [],
    };
    const after = {
      nodes: [node("n1", "Trigger"), node("n2", "Send")],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
    };
    const diff = computeVersionDiff(before, after);
    expect(diff.connectionsAdded).toEqual([{ from: "Trigger", to: "Send" }]);
    expect(computeVersionDiff(after, before).connectionsRemoved).toEqual([
      { from: "Trigger", to: "Send" },
    ]);
  });

  it("ignores cosmetic edge styling, tracks reconnection", () => {
    const before = {
      nodes: [node("n1", "A"), node("n2", "B")],
      edges: [{ id: "e1", source: "n1", target: "n2", animated: false }],
    };
    const styled = {
      nodes: [node("n1", "A"), node("n2", "B")],
      edges: [{ id: "e1", source: "n1", target: "n2", animated: true }],
    };
    expect(computeVersionDiff(before, styled).hasChanges).toBe(false);
  });

  it("returns empty diff when there is no previous version", () => {
    const after = { nodes: [node("n1", "A")], edges: [] };
    expect(computeVersionDiff(null, after).hasChanges).toBe(false);
  });
});
