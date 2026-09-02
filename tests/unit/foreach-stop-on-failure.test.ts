/**
 * For Each stop-on-failure: post-loop Collect / done-targets must not run
 * after any failed iteration.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  countIterationFailures,
  dispatchForEachPostLoopIfNeeded,
  findFirstIterationFailure,
  markCollectSkippedOnForEachFailure,
} from "@/lib/workflow/executor/executor.workflow";

const markedFailure = {
  __forEachBodyFailure: true as const,
  success: false as const,
  error: "boom",
  nodeId: "step-a",
};

describe("findFirstIterationFailure", () => {
  it("returns undefined when all iterations succeeded", () => {
    expect(
      findFirstIterationFailure([
        { success: true, data: 1 },
        { success: true, data: 2 },
      ])
    ).toBeUndefined();
  });

  it("returns the first marked body failure", () => {
    expect(
      findFirstIterationFailure([
        { success: true },
        markedFailure,
        {
          __forEachBodyFailure: true as const,
          success: false as const,
          error: "later",
        },
      ])
    ).toEqual(markedFailure);
  });

  it("ignores bare success:false shapes without the marker", () => {
    expect(
      findFirstIterationFailure([
        { success: false, error: "api error object" },
        markedFailure,
      ])
    ).toEqual(markedFailure);
    expect(
      findFirstIterationFailure([{ success: false, error: "api error object" }])
    ).toBeUndefined();
  });

  it("ignores null and non-object results", () => {
    expect(findFirstIterationFailure([null, "x", markedFailure])).toEqual(
      markedFailure
    );
  });
});

describe("countIterationFailures", () => {
  it("counts only marked body failures", () => {
    const results = Array.from({ length: 500 }, (_, index) => {
      if (index === 1 || index === 50 || index === 400) {
        return {
          __forEachBodyFailure: true as const,
          success: false as const,
          error: `fail-${index}`,
        };
      }
      if (index === 10) {
        return { success: false, error: "api-shaped output" };
      }
      return { ok: index };
    });

    expect(countIterationFailures(results)).toBe(3);
  });
});

describe("markCollectSkippedOnForEachFailure", () => {
  it("marks aggregate Collect visited and records explicit failure", () => {
    const visited = new Set<string>();
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {};

    markCollectSkippedOnForEachFailure({
      aggregateCollectNodeId: "done-collect",
      collectNodeId: "legacy-collect",
      doneCollectNodeId: "done-collect",
      error: "body failed",
      currentVisited: visited,
      currentResults: results,
    });

    expect(visited.has("done-collect")).toBe(true);
    expect(visited.has("legacy-collect")).toBe(true);
    expect(results["done-collect"]).toEqual({
      success: false,
      error: "body failed",
    });
  });

  it("does not mark legacy in-body Collect when it is the done Collect", () => {
    const visited = new Set<string>();
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {};

    markCollectSkippedOnForEachFailure({
      aggregateCollectNodeId: "collect-1",
      collectNodeId: "collect-1",
      doneCollectNodeId: "collect-1",
      error: "body failed",
      currentVisited: visited,
      currentResults: results,
    });

    expect([...visited]).toEqual(["collect-1"]);
    expect(results["collect-1"]?.success).toBe(false);
  });
});

describe("dispatchForEachPostLoopIfNeeded", () => {
  it("skips Collect and done-targets when an iteration failed", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn();

    const result = await dispatchForEachPostLoopIfNeeded({
      firstIterationFailure: {
        __forEachBodyFailure: true,
        success: false,
        error: "body failed",
      },
      continuation: { kind: "aggregate-collect", collectNodeId: "collect-1" },
      onAggregateCollect,
      onDoneTargets,
    });

    expect(result).toBe("skipped");
    expect(onAggregateCollect).not.toHaveBeenCalled();
    expect(onDoneTargets).not.toHaveBeenCalled();
  });

  it("skips done-targets continuation when an iteration failed", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn();

    const result = await dispatchForEachPostLoopIfNeeded({
      firstIterationFailure: {
        __forEachBodyFailure: true,
        success: false,
        error: "body failed",
      },
      continuation: { kind: "done-targets", targets: ["after-1"] },
      onAggregateCollect,
      onDoneTargets,
    });

    expect(result).toBe("skipped");
    expect(onDoneTargets).not.toHaveBeenCalled();
  });

  it("runs aggregate-collect when all iterations succeeded", async () => {
    const onAggregateCollect = vi.fn().mockResolvedValue(undefined);
    const onDoneTargets = vi.fn();

    const result = await dispatchForEachPostLoopIfNeeded({
      firstIterationFailure: undefined,
      continuation: { kind: "aggregate-collect", collectNodeId: "collect-1" },
      onAggregateCollect,
      onDoneTargets,
    });

    expect(result).toBe("aggregate-collect");
    expect(onAggregateCollect).toHaveBeenCalledWith("collect-1");
    expect(onDoneTargets).not.toHaveBeenCalled();
  });

  it("runs done-targets when all iterations succeeded", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchForEachPostLoopIfNeeded({
      firstIterationFailure: undefined,
      continuation: { kind: "done-targets", targets: ["a", "b"] },
      onAggregateCollect,
      onDoneTargets,
    });

    expect(result).toBe("done-targets");
    expect(onDoneTargets).toHaveBeenCalledWith(["a", "b"]);
    expect(onAggregateCollect).not.toHaveBeenCalled();
  });

  it("returns none when there is no post-loop continuation", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn();

    const result = await dispatchForEachPostLoopIfNeeded({
      firstIterationFailure: undefined,
      continuation: { kind: "none" },
      onAggregateCollect,
      onDoneTargets,
    });

    expect(result).toBe("none");
    expect(onAggregateCollect).not.toHaveBeenCalled();
    expect(onDoneTargets).not.toHaveBeenCalled();
  });
});
