import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc-provider";
import type { NonceSession } from "../nonce-manager";
import type { TriggerType } from "../transaction-manager";

export type TransactionReceipt = {
  hash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: number;
};

export type GasOverrides = {
  multiplierOverride?: number;
  gasLimitOverride?: bigint;
};

export type SendTransactionRequest = {
  to: string;
  value?: bigint;
  data?: string;
};

export type ContractCallRequest = {
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  functionKey: string;
  args: unknown[];
  value?: bigint;
};

export type ReadContractRequest = {
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  functionKey: string;
  args: unknown[];
  isView: boolean;
};

export interface ChainAdapter {
  readonly chainFamily: string;

  // ---- Write operations ----

  sendTransaction(
    signer: ethers.Signer,
    request: SendTransactionRequest,
    session: NonceSession,
    options: TransactionOptions
  ): Promise<TransactionReceipt>;

  executeContractCall(
    signer: ethers.Signer,
    request: ContractCallRequest,
    session: NonceSession,
    options: TransactionOptions
  ): Promise<TransactionReceipt>;

  // ---- Read operations ----

  readContract(
    rpcManager: RpcProviderManager,
    request: ReadContractRequest
  ): Promise<unknown>;

  getBalance(rpcManager: RpcProviderManager, address: string): Promise<bigint>;

  executeWithFailover<T>(
    rpcManager: RpcProviderManager,
    operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
    operationType?: "read" | "write"
  ): Promise<T>;

  // ---- Explorer ----

  getTransactionUrl(txHash: string): Promise<string>;

  getAddressUrl(address: string): Promise<string>;
}

export type TransactionOptions = {
  triggerType: TriggerType;
  gasOverrides: GasOverrides;
  workflowId?: string;
  rpcManager?: RpcProviderManager;
};
