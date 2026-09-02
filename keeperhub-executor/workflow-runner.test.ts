import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_TIMEOUT_MS } from "../lib/workflow/executor/runner-constants";

// The runner opens its database client, registers the signal handlers, and
// starts main() when it is imported. Everything main() reaches for is stubbed
// so the module loads under vitest and parks on a workflow that never finishes,
// which is the state a SIGTERM finds a live pod in.
const mocks = vi.hoisted(() => ({
  updateExecutionStatus: vi.fn(),
  updateScheduleStatus: vi.fn(),
  initializeExecutionProgress: vi.fn(),
  applyExecutionResult: vi.fn(),
  shipMetricsToExecutor: vi.fn(),
  queryClientEnd: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("postgres", () => ({
  default: () => ({ end: mocks.queryClientEnd }),
}));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: () => ({}) }));
vi.mock("../lib/db/integrations", () => ({
  validateWorkflowIntegrations: () => Promise.resolve({ valid: true }),
}));
vi.mock("../lib/workflow/load-for-execution", () => ({
  loadWorkflowForExecution: () =>
    Promise.resolve({
      status: "ok",
      workflow: {
        id: "wf-1",
        name: "Parked workflow",
        nodes: [],
        edges: [],
        organizationId: "org-1",
      },
      organizationName: "Org",
    }),
}));
vi.mock("../lib/workflow/executor/build-executor-input", () => ({
  buildExecutorInput: () => ({}),
}));
vi.mock("../lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: () => new Promise(() => undefined),
}));
vi.mock("./lib/db-helpers", () => ({
  updateExecutionStatus: mocks.updateExecutionStatus,
  updateScheduleStatus: mocks.updateScheduleStatus,
  initializeExecutionProgress: mocks.initializeExecutionProgress,
  applyExecutionResult: mocks.applyExecutionResult,
}));
vi.mock("./lib/ship-metrics", () => ({
  shipMetricsToExecutor: mocks.shipMetricsToExecutor,
}));

type SignalListener = (...args: unknown[]) => unknown;

/**
 * Import a fresh runner instance and return the SIGTERM listener it
 * registered. The listener is invoked directly rather than by emitting a
 * signal, which would also reach the listeners the test runner installs on
 * this process.
 */
async function loadRunner(): Promise<SignalListener> {
  const before = new Set(process.listeners("SIGTERM"));
  vi.resetModules();
  await import("./workflow-runner");
  const added = process
    .listeners("SIGTERM")
    .filter((listener) => !before.has(listener));
  expect(added).toHaveLength(1);
  // main() has parked on executeWorkflow once progress initialization ran.
  await vi.waitFor(() =>
    expect(mocks.initializeExecutionProgress).toHaveBeenCalled()
  );
  return added[0] as SignalListener;
}

function firstCallOrder(fn: { mock: { invocationCallOrder: number[] } }): number {
  return fn.mock.invocationCallOrder[0];
}

describe("handleGracefulShutdown", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) {
      fn.mockReset();
    }
    mocks.updateExecutionStatus.mockResolvedValue(undefined);
    mocks.updateScheduleStatus.mockResolvedValue(undefined);
    mocks.initializeExecutionProgress.mockResolvedValue(undefined);
    mocks.queryClientEnd.mockResolvedValue(undefined);
    process.env.DATABASE_URL =
      "postgresql://runner:runner@localhost:5432/runner";
    process.env.WORKFLOW_ID = "wf-1";
    process.env.EXECUTION_ID = "exec-1";
    process.env.SCHEDULE_ID = "sched-1";
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ships the terminal counters after the status write and before exiting", async () => {
    mocks.shipMetricsToExecutor.mockResolvedValue(undefined);
    const onSigterm = await loadRunner();
    mocks.updateExecutionStatus.mockClear();

    await onSigterm("SIGTERM");

    expect(mocks.updateExecutionStatus).toHaveBeenCalledWith(
      expect.anything(),
      "exec-1",
      "error",
      { error: "Workflow terminated by SIGTERM signal" }
    );
    expect(mocks.shipMetricsToExecutor).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(firstCallOrder(mocks.updateExecutionStatus)).toBeLessThan(
      firstCallOrder(mocks.shipMetricsToExecutor)
    );
    expect(firstCallOrder(mocks.shipMetricsToExecutor)).toBeLessThan(
      firstCallOrder(vi.mocked(process.exit))
    );
  });

  it("still force-exits on the shutdown timer when shipping hangs", async () => {
    mocks.shipMetricsToExecutor.mockReturnValue(
      new Promise<void>(() => undefined)
    );
    const onSigterm = await loadRunner();
    vi.useFakeTimers();

    onSigterm("SIGTERM");
    await vi.waitFor(() =>
      expect(mocks.shipMetricsToExecutor).toHaveBeenCalledTimes(1)
    );
    expect(process.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
