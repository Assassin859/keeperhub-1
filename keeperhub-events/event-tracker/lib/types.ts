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

/**
 * The loose shape of a workflow as returned by the KeeperHub API's
 * `/api/workflows/events?active=true` endpoint. Kept intentionally
 * permissive on every field except `id` and `nodes` - those are the
 * minimum required for any downstream code to do useful work. Other
 * fields are typed optionally so the type system does not lie: a
 * malformed API response can still compile and will be caught by the
 * defensive parsing in `workflow-mapper.ts::buildRegistration`.
 */
export interface RawWorkflowNodeConfig {
  network?: string;
  eventName?: string;
  contractABI?: string;
  triggerType?: string;
  contractAddress?: string;
  /**
   * Solana Event trigger fields. Present only when the selected network is a
   * Solana chain (`chainType === "solana"`). `programId` is a base58 program
   * address; `idl` is an Anchor IDL JSON string used for typed event decoding
   * (absent -> raw log mode); `eventName` (reused above) names the Anchor event
   * to match in typed mode; `commitment` defaults to "confirmed".
   */
  programId?: string;
  idl?: string;
  commitment?: string;
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
