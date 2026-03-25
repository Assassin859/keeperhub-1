import type { WorkflowNode } from "../lib/workflow-store";

export type ScheduleMessage = {
  workflowId: string;
  scheduleId: string;
  triggerTime: string;
  triggerType: "schedule";
};

export type BlockMessage = {
  workflowId: string;
  userId: string;
  triggerType: "block";
  triggerData: {
    blockNumber: number;
    blockHash: string;
    blockTimestamp: number;
    parentHash: string;
  };
};

export type EventMessage = {
  workflowId: string;
  userId: string;
  triggerType: "event";
  triggerData: {
    contractAddress?: string;
    eventName?: string;
    transactionHash?: string;
    blockNumber?: number;
    args?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

export type ExecutorMessage = ScheduleMessage | BlockMessage | EventMessage;

export type DispatchTarget = "k8s-job" | "in-process" | "api";

export type WorkflowRecord = {
  id: string;
  name: string | null;
  enabled: boolean | null;
  userId: string;
  organizationId: string | null;
  nodes: WorkflowNode[];
  edges: unknown[];
};
