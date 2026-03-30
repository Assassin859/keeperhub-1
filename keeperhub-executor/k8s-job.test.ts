import type { V1Job } from "@kubernetes/client-node";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

let mockCreateNamespacedJob: Mock;

vi.mock("@kubernetes/client-node", () => {
  mockCreateNamespacedJob = vi.fn().mockResolvedValue({
    metadata: { name: "workflow-test-123" },
  } as V1Job);

  class MockKubeConfig {
    loadFromDefault(): void {
      // no-op for test mock
    }
    makeApiClient(): { createNamespacedJob: Mock } {
      return { createNamespacedJob: mockCreateNamespacedJob };
    }
  }

  return {
    KubeConfig: MockKubeConfig,
    BatchV1Api: class {},
  };
});

vi.mock("./config", () => ({
  CONFIG: {
    databaseUrl: "postgres://localhost/test",
    integrationEncryptionKey: "test-enc-key",
    paraApiKey: "test-para-key",
    paraEnvironment: "beta",
    walletEncryptionKey: "test-wallet-key",
    chainRpcConfig: '{"eth":"http://localhost:8545"}',
    etherscanApiKey: "test-etherscan-key",
    namespace: "test-ns",
    runnerImage: "runner:latest",
    imagePullPolicy: "Never",
    jobTtlSeconds: 3600,
    jobActiveDeadline: 300,
    maxConcurrentJobs: 5,
  },
}));

vi.mock("./runner-env", () => ({
  getRunnerSystemEnvVars: vi.fn().mockReturnValue([
    { name: "OPENAI_API_KEY", value: "sk-test" },
    { name: "SLACK_API_KEY", value: "xoxb-test" },
  ]),
}));

const { createWorkflowJob } = await import("./k8s-job");
const { CONFIG } = await import("./config");
const { getRunnerSystemEnvVars } = await import("./runner-env");

function getSubmittedJob(): V1Job {
  const call = mockCreateNamespacedJob.mock.calls[0][0];
  return call.body as V1Job;
}

function getJobEnvVars(job: V1Job): Array<{ name: string; value: string }> {
  return (job.spec?.template?.spec?.containers?.[0]?.env ?? []) as Array<{
    name: string;
    value: string;
  }>;
}

function getEnvVar(
  envVars: Array<{ name: string; value: string }>,
  name: string
): string | undefined {
  return envVars.find((v) => v.name === name)?.value;
}

describe("createWorkflowJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CONFIG as Record<string, unknown>).etherscanApiKey = "test-etherscan-key";
  });

  it("includes ETHERSCAN_API_KEY when configured", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: { triggerType: "schedule" },
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "ETHERSCAN_API_KEY")).toBe("test-etherscan-key");
  });

  it("omits ETHERSCAN_API_KEY when not configured", async () => {
    (CONFIG as Record<string, unknown>).etherscanApiKey = "";

    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(envVars.find((v) => v.name === "ETHERSCAN_API_KEY")).toBeUndefined();
  });

  it("includes system env vars from runner-env", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "OPENAI_API_KEY")).toBe("sk-test");
    expect(getEnvVar(envVars, "SLACK_API_KEY")).toBe("xoxb-test");
  });

  it("deduplicates system vars against explicit vars", async () => {
    (getRunnerSystemEnvVars as Mock).mockReturnValue([
      { name: "DATABASE_URL", value: "should-be-ignored" },
      { name: "OPENAI_API_KEY", value: "sk-test" },
    ]);

    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    const dbUrls = envVars.filter((v) => v.name === "DATABASE_URL");
    expect(dbUrls).toHaveLength(1);
    expect(dbUrls[0].value).toBe("postgres://localhost/test");
  });

  it("includes SCHEDULE_ID for scheduled triggers", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "schedule",
      scheduleId: "sched-42",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(getEnvVar(envVars, "SCHEDULE_ID")).toBe("sched-42");
  });

  it("omits SCHEDULE_ID for non-scheduled triggers", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: {},
      triggerType: "block",
    });

    const envVars = getJobEnvVars(getSubmittedJob());
    expect(envVars.find((v) => v.name === "SCHEDULE_ID")).toBeUndefined();
  });

  it("includes all infrastructure env vars", async () => {
    await createWorkflowJob({
      workflowId: "wf-1",
      executionId: "exec-1234abcd",
      input: { test: true },
      triggerType: "schedule",
    });

    const envVars = getJobEnvVars(getSubmittedJob());

    expect(getEnvVar(envVars, "WORKFLOW_ID")).toBe("wf-1");
    expect(getEnvVar(envVars, "EXECUTION_ID")).toBe("exec-1234abcd");
    expect(getEnvVar(envVars, "WORKFLOW_INPUT")).toBe('{"test":true}');
    expect(getEnvVar(envVars, "DATABASE_URL")).toBe(
      "postgres://localhost/test"
    );
    expect(getEnvVar(envVars, "INTEGRATION_ENCRYPTION_KEY")).toBe(
      "test-enc-key"
    );
    expect(getEnvVar(envVars, "PARA_API_KEY")).toBe("test-para-key");
    expect(getEnvVar(envVars, "PARA_ENVIRONMENT")).toBe("beta");
    expect(getEnvVar(envVars, "WALLET_ENCRYPTION_KEY")).toBe("test-wallet-key");
    expect(getEnvVar(envVars, "CHAIN_RPC_CONFIG")).toBe(
      '{"eth":"http://localhost:8545"}'
    );
  });
});
