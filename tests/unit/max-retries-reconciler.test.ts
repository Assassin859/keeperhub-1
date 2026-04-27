import { describe, expect, it } from "vitest";

import {
  getFailedMaxRetriesNodeIds,
  isSdkRetryError,
  reconcileMaxRetriesFailures,
  reconcileSdkFailures,
} from "@/lib/workflow/executor/max-retries-reconciler";

describe("isSdkRetryError", () => {
  it("should match 'exceeded max retries' error format", () => {
    expect(
      isSdkRetryError(
        'Step "step//abc//sendWebhook" exceeded max retries (0 retries)'
      )
    ).toBe(true);
  });

  it("should match 'failed after N retries' error format", () => {
    expect(
      isSdkRetryError(
        'Step "step//abc//checkBalance" failed after 3 retries: Error: step_completed event failed'
      )
    ).toBe(true);
  });

  it("should not match unrelated errors", () => {
    expect(isSdkRetryError("HTTP 500 Internal Server Error")).toBe(false);
    expect(isSdkRetryError("Connection refused")).toBe(false);
    expect(isSdkRetryError(undefined)).toBe(false);
  });
});

describe("getFailedMaxRetriesNodeIds", () => {
  it("should return node IDs with exceeded-max-retries errors", () => {
    const results = {
      "node-1": { success: true },
      "node-2": {
        success: false,
        error: 'Step "step//abc//sendWebhook" exceeded max retries (0 retries)',
      },
      "node-3": { success: false, error: "HTTP 500 Internal Server Error" },
    };

    expect(getFailedMaxRetriesNodeIds(results)).toEqual(["node-2"]);
  });

  it("should return node IDs with failed-after-retries errors", () => {
    const results = {
      "node-1": { success: true },
      "node-2": {
        success: false,
        error:
          'Step "step//abc//checkBalance" failed after 3 retries: step_completed event failed',
      },
    };

    expect(getFailedMaxRetriesNodeIds(results)).toEqual(["node-2"]);
  });

  it("should return empty array when no retry errors", () => {
    const results = {
      "node-1": { success: true },
      "node-2": { success: false, error: "Connection refused" },
    };

    expect(getFailedMaxRetriesNodeIds(results)).toEqual([]);
  });
});

describe("reconcileMaxRetriesFailures", () => {
  it("should return empty overrides when no retry failures exist", () => {
    const results: Record<string, { success: boolean; error?: string }> = {
      "node-1": { success: true },
      "node-2": { success: false, error: "HTTP 500 Internal Server Error" },
    };

    const { overriddenNodeIds } = reconcileMaxRetriesFailures({
      results,
      successfulSteps: new Map(),
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual([]);
  });

  it("should override exceeded-max-retries failure with tracked success", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": { success: true },
      "node-2": {
        success: false,
        error: 'Step "step//abc//sendWebhook" exceeded max retries (0 retries)',
      },
    };

    const successfulSteps = new Map<string, unknown>([
      ["node-2", { statusCode: 200, body: "ok" }],
    ]);

    const { overriddenNodeIds } = reconcileMaxRetriesFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual(["node-2"]);
    expect(results["node-2"]).toEqual({
      success: true,
      data: { statusCode: 200, body: "ok" },
    });
  });

  it("should override failed-after-retries failure with tracked success", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": {
        success: false,
        error:
          'Step "step//abc//checkBalance" failed after 0 retries: step_completed event failed',
      },
    };

    const successfulSteps = new Map<string, unknown>([
      ["node-1", { balance: "1.5" }],
    ]);

    const { overriddenNodeIds } = reconcileMaxRetriesFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual(["node-1"]);
    expect(results["node-1"]).toEqual({
      success: true,
      data: { balance: "1.5" },
    });
  });

  it("should override to success when node output is undefined", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": {
        success: false,
        error: 'Step "step//abc//sendWebhook" exceeded max retries (0 retries)',
      },
    };

    const successfulSteps = new Map<string, unknown>([["node-1", undefined]]);

    const { overriddenNodeIds } = reconcileMaxRetriesFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual(["node-1"]);
    expect(results["node-1"]).toEqual({
      success: true,
      data: undefined,
    });
  });

  it("should NOT override when node has no tracked success", () => {
    const results: Record<string, { success: boolean; error?: string }> = {
      "node-1": {
        success: false,
        error: 'Step "step//abc//condition" exceeded max retries (0 retries)',
      },
    };

    const { overriddenNodeIds } = reconcileMaxRetriesFailures({
      results,
      successfulSteps: new Map(),
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual([]);
  });

  it("should handle multiple failed nodes independently", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": {
        success: false,
        error: 'Step "step//a//webhook" exceeded max retries (0 retries)',
      },
      "node-2": {
        success: false,
        error:
          'Step "step//b//checkBalance" failed after 3 retries: state conflict',
      },
      "node-3": { success: true },
    };

    const successfulSteps = new Map<string, unknown>([
      ["node-1", { sent: true }],
    ]);

    const { overriddenNodeIds } = reconcileMaxRetriesFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual(["node-1"]);
    expect(results["node-1"]).toEqual({
      success: true,
      data: { sent: true },
    });
  });

  it("should not produce overrides for non-retry failures", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": {
        success: false,
        error: 'Step "step//a//webhook" exceeded max retries (0 retries)',
      },
      "node-2": {
        success: false,
        error: "Connection refused",
      },
    };

    const successfulSteps = new Map<string, unknown>([
      ["node-1", { ok: true }],
    ]);

    const { overriddenNodeIds } = reconcileMaxRetriesFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual(["node-1"]);
    expect(results["node-1"]).toEqual({
      success: true,
      data: { ok: true },
    });
  });
});

describe("reconcileSdkFailures", () => {
  it("should return empty overrides when no failures exist", () => {
    const results: Record<string, { success: boolean; error?: string }> = {
      "node-1": { success: true },
      "node-2": { success: true },
    };

    const { overriddenNodeIds } = reconcileSdkFailures({
      results,
      successfulSteps: new Map(),
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual([]);
  });

  it("should override non-max-retries SDK errors when step has tracked success", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": { success: true },
      "node-2": {
        success: false,
        error:
          "Corrupted event log: step step_01ABC (conditionStep) created but not found in invocation queue",
      },
    };

    const successfulSteps = new Map<string, unknown>([
      ["node-2", { condition: false }],
    ]);

    const { overriddenNodeIds } = reconcileSdkFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual(["node-2"]);
    expect(results["node-2"]).toEqual({
      success: true,
      data: { condition: false },
    });
  });

  it("should NOT override failures without tracked success", () => {
    const results: Record<string, { success: boolean; error?: string }> = {
      "node-1": {
        success: false,
        error: "HTTP 500 Internal Server Error",
      },
    };

    const { overriddenNodeIds } = reconcileSdkFailures({
      results,
      successfulSteps: new Map(),
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual([]);
    expect(results["node-1"]?.success).toBe(false);
  });

  it("should handle unexpected event type SDK errors", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": {
        success: false,
        error:
          'Unexpected event type for step step_01XYZ (name: conditionStep) "run_completed"',
      },
    };

    const successfulSteps = new Map<string, unknown>([
      ["node-1", { condition: true }],
    ]);

    const { overriddenNodeIds } = reconcileSdkFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual(["node-1"]);
    expect(results["node-1"]).toEqual({
      success: true,
      data: { condition: true },
    });
  });

  it("should handle multiple SDK failures with mixed tracked success", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": { success: true },
      "node-2": {
        success: false,
        error: "SDK state replay mismatch",
      },
      "node-3": {
        success: false,
        error: "Connection refused",
      },
      "node-4": {
        success: false,
        error: "Event log conflict during parallel execution",
      },
    };

    const successfulSteps = new Map<string, unknown>([
      ["node-2", { sent: true }],
      ["node-4", { balance: "1000" }],
    ]);

    const { overriddenNodeIds } = reconcileSdkFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual(["node-2", "node-4"]);
    expect(results["node-2"]).toEqual({ success: true, data: { sent: true } });
    expect(results["node-3"]?.success).toBe(false);
    expect(results["node-4"]).toEqual({
      success: true,
      data: { balance: "1000" },
    });
  });

  it("should not re-override nodes already fixed by max-retries reconciler", () => {
    const results: Record<
      string,
      { success: boolean; error?: string; data?: unknown }
    > = {
      "node-1": { success: true, data: { ok: true } },
    };

    const successfulSteps = new Map<string, unknown>([
      ["node-1", { ok: true }],
    ]);

    const { overriddenNodeIds } = reconcileSdkFailures({
      results,
      successfulSteps,
      executionId: "exec-1",
      workflowId: "wf-1",
    });

    expect(overriddenNodeIds).toEqual([]);
  });
});
