export type ExecutionStatus = "pending" | "running" | "completed" | "failed";

export type ExecuteResponse = {
  executionId: string;
  status: ExecutionStatus;
};

export type ExecutionStatusResponse = {
  executionId: string;
  status: ExecutionStatus;
  type: string;
  transactionHash: string | null;
  transactionLink: string | null;
  result: unknown;
  error: string | null;
  gasUsedWei: string | null;
  gasPriceWei: string | null;
  estimatedCostUsd: string | null;
  retryCount: number;
  network: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ExecuteErrorResponse = {
  error: string;
  details?: string;
  field?: string;
};

export type RetryConfig = {
  maxRetries?: number;
  timeoutMs?: number;
  gasBumpPercent?: number;
};

export type NodeExecuteRequest = {
  actionType: string;
  config: Record<string, unknown>;
  integrationId?: string;
  network?: string;
  retry?: RetryConfig;
};
