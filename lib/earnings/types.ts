export type SettlementStatus = "settled" | "pending" | "no_payments";

export type WorkflowEarningsRow = {
  workflowId: string;
  workflowName: string;
  listedSlug: string | null;
  grossRevenue: string;
  creatorShare: string;
  platformFee: string;
  invocationCount: number;
  topCallers: string[];
  settlementStatus: SettlementStatus;
};

export type EarningsSummary = {
  totalGrossRevenue: string;
  totalCreatorEarnings: string;
  totalPlatformFees: string;
  totalInvocations: number;
  platformFeePercent: number;
  creatorSharePercent: number;
  workflows: WorkflowEarningsRow[];
  total: number;
  page: number;
  pageSize: number;
  hasListedWorkflows: boolean;
};
