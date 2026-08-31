/**
 * For Each stop-on-failure: post-loop Collect / done-targets must not run
 * after any failed iteration.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  dispatchForEachPostLoopIfNeeded,
  findFirstIterationFailure,
} from "@/lib/workflow/executor/executor.workflow";

describe("findFirstIterationFailure", () => {
  it("returns undefined when all iterations succeeded", () => {
    expect(
      findFirstIterationFailure([
        { success: true, data: 1 },
        { success: true, data: 2 },
      ])
    ).toBeUndefined();
  });

  it("returns the first failed iteration", () => {
    expect(
      findFirstIterationFailure([
        { success: true },
        { success: false, error: "boom" },
        { success: false, error: "later" },
      ])
    ).toEqual({ success: false, error: "boom" });
  });

  it("ignores null and non-object results", () => {
    expect(
      findFirstIterationFailure([null, "x", { success: false, error: "e" }])
    ).toEqual({ success: false, error: "e" });
  });
});

describe("dispatchForEachPostLoopIfNeeded", () => {
  it("skips Collect and done-targets when an iteration failed", async () => {
    const onAggregateCollect = vi.fn();
    const onDoneTargets = vi.fn();

    const result = await dispatchForEachPostLoopIfNeeded({
      firstIterationFailure: { success: false, error: "body failed" },
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
      firstIterationFailure: { success: false, error: "body failed" },
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
