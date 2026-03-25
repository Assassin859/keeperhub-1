import type { ChildProcess } from "node:child_process";
import type { WorkflowHandler } from "../src/process/workflow-handler";

export interface NetworkConfig {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  defaultPrimaryRpc: string;
  defaultFallbackRpc: string;
  defaultPrimaryWss: string;
  defaultFallbackWss: string;
  isTestnet: boolean;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NetworksMap = Record<number, NetworkConfig>;

export interface NetworksWrapper {
  networks: NetworksMap;
}

export interface ProcessEntry {
  process: ChildProcess | null;
  handler: WorkflowHandler;
}

export interface ChildProcessMap {
  [workflowId: string]: ProcessEntry;
}

export interface ProcessStatusMessage {
  status: string;
  chain?: string;
  pid?: number;
  reason?: string;
  attempt?: number;
  error?: string;
}

export interface SyncData {
  workflows: any[];
  networks: NetworksMap;
}
