import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import {
  getAddressUrl as buildAddressUrl,
  getTransactionUrl as buildTransactionUrl,
} from "@/lib/explorer";
import type { RpcProviderManager } from "@/lib/rpc-provider";
import type { AdaptiveGasStrategy, GasConfig } from "../gas-strategy";
import type { NonceManager, NonceSession } from "../nonce-manager";
import type {
  ChainAdapter,
  ContractCallRequest,
  ReadContractRequest,
  SendTransactionRequest,
  TransactionOptions,
  TransactionReceipt,
} from "./types";

export class EvmChainAdapter implements ChainAdapter {
  readonly chainFamily = "evm";
  private readonly chainId: number;
  private readonly gasStrategy: AdaptiveGasStrategy;
  private readonly nonceManager: NonceManager;
  private explorerConfigCache: typeof explorerConfigs.$inferSelect | null =
    null;
  private explorerConfigLoaded = false;

  constructor(
    chainId: number,
    gasStrategy: AdaptiveGasStrategy,
    nonceManager: NonceManager
  ) {
    this.chainId = chainId;
    this.gasStrategy = gasStrategy;
    this.nonceManager = nonceManager;
  }

  async sendTransaction(
    signer: ethers.Signer,
    request: SendTransactionRequest,
    session: NonceSession,
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    const provider = signer.provider;
    if (!provider) {
      throw new Error("Signer has no provider");
    }

    const walletAddress = await signer.getAddress();
    const baseTx: ethers.TransactionRequest = {
      to: request.to,
      value: request.value,
      data: request.data,
    };

    if (options.rpcManager) {
      await options.rpcManager.executeWithFailover(
        (rpcProvider) => rpcProvider.call({ ...baseTx, from: walletAddress }),
        "preflight"
      );
    } else {
      await provider.call({ ...baseTx, from: walletAddress });
    }

    const nonce = this.nonceManager.getNextNonce(session);

    const estimatedGas = options.rpcManager
      ? await options.rpcManager.executeWithFailover(
          (rpcProvider) =>
            rpcProvider.estimateGas({ ...baseTx, from: walletAddress }),
          "preflight"
        )
      : await provider.estimateGas({ ...baseTx, from: walletAddress });

    const gasConfig = await this.gasStrategy.getGasConfig(
      provider,
      options.triggerType,
      estimatedGas,
      this.chainId,
      options.gasOverrides.multiplierOverride,
      options.gasOverrides.gasLimitOverride
    );

    const tx = await signer.sendTransaction({
      ...baseTx,
      nonce,
      gasLimit: gasConfig.gasLimit,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
    });

    return this.confirmTransaction(tx, session, nonce, gasConfig, options);
  }

  async executeContractCall(
    signer: ethers.Signer,
    request: ContractCallRequest,
    session: NonceSession,
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    const provider = signer.provider;
    if (!provider) {
      throw new Error("Signer has no provider");
    }

    let contract: ethers.Contract;
    try {
      contract = new ethers.Contract(
        request.contractAddress,
        request.abi,
        signer
      );
    } catch (error) {
      throw new Error(
        `Failed to create contract instance: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (typeof contract[request.functionKey] !== "function") {
      throw new Error(
        `Function '${request.functionKey}' not found in contract ABI`
      );
    }

    const signerAddress = await signer.getAddress();
    const callOverrides = {
      ...(request.value ? { value: request.value } : {}),
      from: signerAddress,
    };

    if (options.rpcManager) {
      await options.rpcManager.executeWithFailover((rpcProvider) => {
        const readContract = new ethers.Contract(
          request.contractAddress,
          request.abi,
          rpcProvider
        );
        return readContract[request.functionKey].staticCall(
          ...request.args,
          callOverrides
        );
      }, "preflight");
    } else {
      await contract[request.functionKey].staticCall(
        ...request.args,
        callOverrides
      );
    }

    const nonce = this.nonceManager.getNextNonce(session);

    const estimatedGas = options.rpcManager
      ? await options.rpcManager.executeWithFailover((rpcProvider) => {
          const readContract = new ethers.Contract(
            request.contractAddress,
            request.abi,
            rpcProvider
          );
          return readContract[request.functionKey].estimateGas(
            ...request.args,
            callOverrides
          );
        }, "preflight")
      : await contract[request.functionKey].estimateGas(
          ...request.args,
          callOverrides
        );

    const gasConfig = await this.gasStrategy.getGasConfig(
      provider,
      options.triggerType,
      estimatedGas,
      this.chainId,
      options.gasOverrides.multiplierOverride,
      options.gasOverrides.gasLimitOverride
    );

    const tx = await contract[request.functionKey](...request.args, {
      nonce,
      gasLimit: gasConfig.gasLimit,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
      ...(request.value ? { value: request.value } : {}),
    });

    return this.confirmTransaction(tx, session, nonce, gasConfig, options);
  }

  async readContract(
    rpcManager: RpcProviderManager,
    request: ReadContractRequest
  ): Promise<unknown> {
    return await rpcManager.executeWithFailover(async (provider) => {
      const contract = new ethers.Contract(
        request.contractAddress,
        request.abi,
        provider
      );

      if (typeof contract[request.functionKey] !== "function") {
        throw new Error(
          `Function '${request.functionKey}' not found in contract ABI`
        );
      }

      return request.isView
        ? await contract[request.functionKey](...request.args)
        : await contract[request.functionKey].staticCall(...request.args);
    });
  }

  async getBalance(
    rpcManager: RpcProviderManager,
    address: string
  ): Promise<bigint> {
    return await rpcManager.executeWithFailover(async (provider) =>
      provider.getBalance(address)
    );
  }

  async executeWithFailover<T>(
    rpcManager: RpcProviderManager,
    operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
    operationType?: "read" | "write"
  ): Promise<T> {
    return await rpcManager.executeWithFailover(operation, operationType);
  }

  async getTransactionUrl(txHash: string): Promise<string> {
    const config = await this.getExplorerConfig();
    if (!config) {
      return "";
    }
    return buildTransactionUrl(config, txHash);
  }

  async getAddressUrl(address: string): Promise<string> {
    const config = await this.getExplorerConfig();
    if (!config) {
      return "";
    }
    return buildAddressUrl(config, address);
  }

  private async confirmTransaction(
    tx: ethers.TransactionResponse,
    session: NonceSession,
    nonce: number,
    gasConfig: GasConfig,
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    await this.nonceManager.recordTransaction(
      session,
      nonce,
      tx.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("Transaction sent but receipt not available");
    }

    await this.nonceManager.confirmTransaction(tx.hash);

    return {
      hash: receipt.hash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      blockNumber: receipt.blockNumber,
    };
  }

  private async getExplorerConfig(): Promise<
    typeof explorerConfigs.$inferSelect | undefined
  > {
    if (this.explorerConfigLoaded) {
      return this.explorerConfigCache ?? undefined;
    }

    const config = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, this.chainId),
    });

    this.explorerConfigCache = config ?? null;
    this.explorerConfigLoaded = true;
    return config ?? undefined;
  }
}
