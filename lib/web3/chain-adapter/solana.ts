import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { NonceSession } from "../nonce-manager";
import type {
  ChainAdapter,
  ContractCallRequest,
  ReadContractRequest,
  SendTransactionRequest,
  TransactionOptions,
  TransactionReceipt,
} from "./types";

export class SolanaChainAdapter implements ChainAdapter {
  readonly chainFamily = "solana";
  private readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  sendTransaction(
    _signer: ethers.Signer,
    _request: SendTransactionRequest,
    _session: NonceSession,
    _options: TransactionOptions
  ): Promise<TransactionReceipt> {
    return Promise.reject(
      new Error(
        `Solana sendTransaction not implemented (chainId: ${this.chainId})`
      )
    );
  }

  executeContractCall(
    _signer: ethers.Signer,
    _request: ContractCallRequest,
    _session: NonceSession,
    _options: TransactionOptions
  ): Promise<TransactionReceipt> {
    return Promise.reject(
      new Error(
        `Solana executeContractCall not implemented (chainId: ${this.chainId})`
      )
    );
  }

  readContract(
    _rpcManager: RpcProviderManager,
    _request: ReadContractRequest
  ): Promise<unknown> {
    return Promise.reject(
      new Error(
        `Solana readContract not implemented (chainId: ${this.chainId})`
      )
    );
  }

  getBalance(
    _rpcManager: RpcProviderManager,
    _address: string
  ): Promise<bigint> {
    return Promise.reject(
      new Error(`Solana getBalance not implemented (chainId: ${this.chainId})`)
    );
  }

  executeWithFailover<T>(
    _rpcManager: RpcProviderManager,
    _operation: (provider: ethers.JsonRpcProvider) => Promise<T>
  ): Promise<T> {
    return Promise.reject(
      new Error(
        `Solana executeWithFailover not implemented (chainId: ${this.chainId})`
      )
    );
  }

  getTransactionUrl(_txHash: string): Promise<string> {
    return Promise.reject(
      new Error(
        `Solana getTransactionUrl not implemented (chainId: ${this.chainId})`
      )
    );
  }

  getAddressUrl(_address: string): Promise<string> {
    return Promise.reject(
      new Error(
        `Solana getAddressUrl not implemented (chainId: ${this.chainId})`
      )
    );
  }
}
