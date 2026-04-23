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

/**
 * The loose shape of a workflow as returned by the KeeperHub API's
 * `/api/workflows/events?active=true` endpoint. Kept intentionally
 * permissive on every field except `id` and `nodes` - those are the
 * minimum required for any downstream code (fork or in-proc) to do
 * useful work. Other fields are typed optionally so the type system
 * does not lie: a malformed API response can still compile and will be
 * caught by the defensive parsing in `workflow-mapper.ts::buildRegistration`
 * (in-proc path) or by `WorkflowEvent`'s constructor (fork path).
 */
export interface RawWorkflowNodeConfig {
  network?: string;
  eventName?: string;
  contractABI?: string;
  triggerType?: string;
  contractAddress?: string;
}

export interface RawWorkflowNode {
  id?: string;
  type?: string;
  selected?: boolean;
  data?: {
    type?: string;
    label?: string;
    config?: RawWorkflowNodeConfig;
    status?: string;
    description?: string;
  };
}

export interface RawWorkflow {
  id?: string;
  nodes?: RawWorkflowNode[];
  name?: string;
  userId?: string;
  organizationId?: string;
  enabled?: boolean;
}

export interface SyncData {
  workflows: RawWorkflow[];
  networks: NetworksMap;
}
