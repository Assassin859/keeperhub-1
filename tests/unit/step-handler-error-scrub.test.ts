import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));
vi.mock("@/lib/metrics/instrumentation/workflow", () => ({
  recordStepMetrics: vi.fn(),
}));
vi.mock("@/lib/workflow/executor/logging", () => ({
  incrementCompletedSteps: vi.fn(),
  logStepCompleteDb: vi.fn(),
  logStepStartDb: vi.fn(),
  logWorkflowCompleteDb: vi.fn(),
  updateCurrentStep: vi.fn(),
}));

import { recordStepMetrics } from "@/lib/metrics/instrumentation/workflow";
import {
  logStepCompleteDb,
  logStepStartDb,
} from "@/lib/workflow/executor/logging";
import {
  type StepContext,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

const FAKE_DRPC_KEY = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAAAAAAAAAAAA";
const KEYED_URL = `https://lb.drpc.live/ethereum/${FAKE_DRPC_KEY}`;

const context: StepContext = {
  executionId: "exec-1",
  nodeId: "node-1",
  nodeName: "Query Poke Events",
  nodeType: "web3/query-events",
};

describe("withStepLogging error scrubbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logStepStartDb).mockResolvedValue({
      logId: "log-1",
      startTime: Date.now(),
    });
  });

  it("scrubs keyed RPC URLs from returned error results before persisting and returning", async () => {
    const rawError = `Event query failed: RPC failed on both endpoints. Fallback: server response 400 Bad Request (info={ "requestUrl": "${KEYED_URL}" })`;

    const result = await withStepLogging({ _context: context }, () =>
      Promise.resolve({ success: false, error: rawError })
    );

    expect(result.error).not.toContain(FAKE_DRPC_KEY);
    expect(result.error).toContain("lb.drpc.live");
    expect(result.error).toContain("[REDACTED]");
    expect(result.error).toContain("RPC failed on both endpoints");

    expect(logStepCompleteDb).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(logStepCompleteDb).mock.calls[0][0];
    expect(persisted.error).not.toContain(FAKE_DRPC_KEY);
    // The result object is persisted whole as output/outputRaw; its error
    // field must carry the scrubbed string too.
    expect((persisted.outputRaw as { error: string }).error).not.toContain(
      FAKE_DRPC_KEY
    );
    expect((persisted.output as { error: string }).error).not.toContain(
      FAKE_DRPC_KEY
    );

    const metrics = vi.mocked(recordStepMetrics).mock.calls[0][0];
    expect(metrics.error).not.toContain(FAKE_DRPC_KEY);
  });

  it("scrubs keyed RPC URLs from thrown errors and rethrows with the masked message", async () => {
    const thrown = new Error(
      `could not coalesce error (info={ "requestUrl": "${KEYED_URL}" }, code=UNKNOWN_ERROR, version=6.16.0)`
    );

    await expect(
      withStepLogging({ _context: context }, () => Promise.reject(thrown))
    ).rejects.toSatisfy((error: unknown) => {
      const message = (error as Error).message;
      expect(message).not.toContain(FAKE_DRPC_KEY);
      expect(message).toContain("lb.drpc.live");
      expect(message).toContain("[REDACTED]");
      return true;
    });

    expect(logStepCompleteDb).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(logStepCompleteDb).mock.calls[0][0];
    expect(persisted.error).not.toContain(FAKE_DRPC_KEY);
  });

  it("survives frozen thrown errors without masking the failure", async () => {
    const frozen = Object.freeze(
      new Error(`fetch ${KEYED_URL} failed with 401`)
    );

    await expect(
      withStepLogging({ _context: context }, () => Promise.reject(frozen))
    ).rejects.toBe(frozen);
  });
});
