export type ExecutionMode = "isolated" | "process" | "complex";

export const CONFIG = {
  executionMode: (process.env.EXECUTION_MODE || "isolated") as ExecutionMode,

  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/workflow",

  awsRegion: process.env.AWS_REGION || "us-east-1",
  awsEndpoint: process.env.AWS_ENDPOINT_URL,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  sqsQueueUrl:
    process.env.SQS_QUEUE_URL ||
    "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/keeperhub-workflow-queue",

  runnerImage: process.env.RUNNER_IMAGE || "keeperhub-runner:latest",
  imagePullPolicy: process.env.IMAGE_PULL_POLICY || "Never",
  namespace: process.env.K8S_NAMESPACE || "local",
  jobTtlSeconds: Number(process.env.JOB_TTL_SECONDS) || 3600,
  jobActiveDeadline: Number(process.env.JOB_ACTIVE_DEADLINE) || 300,
  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS) || 1,

  keeperhubApiUrl: process.env.KEEPERHUB_API_URL || "http://localhost:3000",
  keeperhubApiKey: process.env.KEEPERHUB_API_KEY || "",

  healthPort: Number(process.env.HEALTH_PORT) || 3080,
  integrationEncryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || "",

  paraApiKey: process.env.PARA_API_KEY || "",
  paraEnvironment: process.env.PARA_ENVIRONMENT || "beta",
  walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || "",
  chainRpcConfig: process.env.CHAIN_RPC_CONFIG || "",
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || "",

  workflowRunnerCollectMonitoring:
    process.env.WORKFLOW_RUNNER_COLLECT_MONITORING !== "false",

  visibilityTimeout: 300,
  waitTimeSeconds: 20,
  maxMessages: 10,
};
