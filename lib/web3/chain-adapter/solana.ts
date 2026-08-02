import {
  type Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { ethers } from "ethers";
import { logWarn } from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { RpcOperationType } from "@/lib/rpc/providers/index";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";
import { getErrorMessage } from "@/lib/utils";
import type { NonceSession } from "../nonce-manager";
import { assertMaxSolLamportsOutflow } from "../solana-max-sol-guard";
import {
  type NormalizedTxResult,
  normalizeSolanaTransaction,
  parseComputeUnitPrice,
} from "../solana-tx-normalize";
import { submitSignedSolanaTransactionWithFailover } from "../submit-signed-solana";
import { buildChainAddressUrl, buildChainTransactionUrl } from "./explorer";
import type {
  ChainAdapter,
  ContractCallRequest,
  ReadContractRequest,
  SendTransactionRequest,
  TransactionOptions,
  TransactionReceipt,
} from "./types";

type SolanaProviderFactory = () => Promise<SolanaProviderManager>;

type SolanaBlockhashRefs = {
  blockhash: string;
  lastValidBlockHeight: number;
};

type SolanaSignedAttempt = {
  signedBytes: Uint8Array;
  signedTx: Transaction | VersionedTransaction;
  isVersioned: boolean;
  normalized: NormalizedTxResult;
  blockhashRefs: SolanaBlockhashRefs;
};

const BLOCKHASH_EXPIRY_PATTERN =
  /blockhashnotfound|block height exceeded|blockhash expired|transaction expired/i;

function isSolanaBlockhashExpiryError(error: unknown): boolean {
  return BLOCKHASH_EXPIRY_PATTERN.test(getErrorMessage(error));
}

export class SolanaChainAdapter implements ChainAdapter {
  readonly chainFamily = "solana";
  private readonly chainId: number;
  private readonly providerFactory: SolanaProviderFactory;
  private managerPromise: Promise<SolanaProviderManager> | null = null;

  constructor(chainId: number, providerFactory: SolanaProviderFactory) {
    this.chainId = chainId;
    this.providerFactory = providerFactory;
  }

  private getManager(): Promise<SolanaProviderManager> {
    // Cache the in-flight promise, not the resolved value, so concurrent
    // callers share a single providerFactory() invocation. This adapter is a
    // process-lifetime singleton (see chain-adapter registry), so it serves
    // overlapping requests.
    this.managerPromise ??= this.providerFactory();
    return this.managerPromise;
  }

  private async buildSignAndSimulate(
    request: SendTransactionRequest,
    options: TransactionOptions,
    solanaSigner: NonNullable<TransactionOptions["solanaSigner"]>,
    signerPublicKey: PublicKey,
    blockhashRefs: SolanaBlockhashRefs
  ): Promise<SolanaSignedAttempt> {
    const normalized = normalizeSolanaTransaction(
      request.data,
      request.to,
      request.value,
      signerPublicKey,
      options.gasOverrides?.priorityFeeOverride,
      options.gasOverrides?.gasLimitOverride
    );

    const isVersioned =
      normalized.mode === "A" && (normalized.isVersioned ?? false);

    if (isVersioned) {
      (normalized.transaction as VersionedTransaction).message.recentBlockhash =
        blockhashRefs.blockhash;
    } else {
      (normalized.transaction as Transaction).recentBlockhash =
        blockhashRefs.blockhash;
    }

    const txToSign = normalized.transaction;
    const serialized = isVersioned
      ? (txToSign as VersionedTransaction).serialize()
      : (txToSign as Transaction).serialize({ requireAllSignatures: false });

    const signedBytes = await solanaSigner.signTransaction(
      new Uint8Array(serialized)
    );

    const signedTx = isVersioned
      ? VersionedTransaction.deserialize(signedBytes)
      : Transaction.from(signedBytes);

    await this.executeWithSolanaFailover(async (connection) => {
      const enforceMaxSol = options.maxSolLamports !== undefined;
      const preBalance = enforceMaxSol
        ? BigInt(await connection.getBalance(signerPublicKey))
        : BigInt(0);

      const simResult = isVersioned
        ? await connection.simulateTransaction(
            signedTx as VersionedTransaction,
            {
              sigVerify: false,
              replaceRecentBlockhash: false,
            }
          )
        : await connection.simulateTransaction(
            signedTx as Transaction,
            undefined,
            enforceMaxSol
          );

      if (simResult.value.err) {
        throw new Error(
          `[SolanaChainAdapter] Simulation failed: ${JSON.stringify(simResult.value.err)}`
        );
      }

      if (enforceMaxSol && options.maxSolLamports !== undefined) {
        const accountKeys = isVersioned
          ? (signedTx as VersionedTransaction).message.staticAccountKeys
          : (signedTx as Transaction).compileMessage().accountKeys;
        const payerIndex = accountKeys.findIndex((key) =>
          key.equals(signerPublicKey)
        );
        if (payerIndex === -1) {
          throw new Error(
            "[SolanaChainAdapter] Fee payer not found in transaction account keys"
          );
        }
        const postLamports = simResult.value.accounts?.[payerIndex]?.lamports;
        if (postLamports === undefined) {
          throw new Error(
            "[SolanaChainAdapter] Simulation did not return fee payer account state for maxSol check"
          );
        }
        const outflow =
          preBalance > BigInt(postLamports)
            ? preBalance - BigInt(postLamports)
            : BigInt(0);
        assertMaxSolLamportsOutflow({
          outflowLamports: outflow,
          maxSolLamports: options.maxSolLamports,
        });
      }
    }, "preflight");

    return {
      signedBytes,
      signedTx,
      isVersioned,
      normalized,
      blockhashRefs,
    };
  }

  async sendTransaction(
    _signer: ethers.Signer, // Unused: Solana uses options.solanaSigner
    request: SendTransactionRequest,
    _session: NonceSession, // Unused: Solana has no EVM nonce concept
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    if (!options.solanaSigner) {
      throw new Error("[SolanaChainAdapter] Missing options.solanaSigner");
    }

    const solanaSigner = options.solanaSigner;

    const signerPublicKey = new PublicKey(
      (await solanaSigner.getPublicKey()).toBase58()
    );

    const manager = await this.getManager();
    let signedAttempt: SolanaSignedAttempt | null = null;
    let signature: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const blockhashRefs = await this.executeWithSolanaFailover(
        (connection) => connection.getLatestBlockhash("confirmed"),
        "read"
      );

      signedAttempt = await this.buildSignAndSimulate(
        request,
        options,
        solanaSigner,
        signerPublicKey,
        blockhashRefs
      );

      try {
        const submitResult = await submitSignedSolanaTransactionWithFailover(
          signedAttempt.signedBytes,
          manager
        );
        signature = submitResult.signature;
        break;
      } catch (error) {
        if (attempt === 0 && isSolanaBlockhashExpiryError(error)) {
          continue;
        }
        throw error;
      }
    }

    if (!(signedAttempt && signature)) {
      throw new Error(
        "[SolanaChainAdapter] Failed to submit transaction after blockhash retry"
      );
    }

    const { blockhashRefs, normalized, isVersioned } = signedAttempt;

    const { confirmationErr, txResult } = await this.executeWithSolanaFailover(
      async (connection) => {
        const confirmation = await connection.confirmTransaction(
          {
            signature,
            blockhash: blockhashRefs.blockhash,
            lastValidBlockHeight: blockhashRefs.lastValidBlockHeight,
          },
          "confirmed"
        );

        const tx = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        return { confirmationErr: confirmation.value.err, txResult: tx };
      },
      "read"
    );

    if (confirmationErr) {
      throw new Error(
        `[SolanaChainAdapter] Transaction ${signature} failed on-chain: ${JSON.stringify(confirmationErr)}`
      );
    }
    if (txResult?.meta?.err) {
      throw new Error(
        `[SolanaChainAdapter] Transaction ${signature} reverted on-chain: ${JSON.stringify(txResult.meta.err)}`
      );
    }

    const computeUnitsConsumed =
      txResult?.meta?.computeUnitsConsumed == null
        ? BigInt(0)
        : BigInt(txResult.meta.computeUnitsConsumed);

    const effectiveGasPrice = parseComputeUnitPrice(
      normalized.transaction,
      isVersioned
    );

    return {
      hash: signature,
      gasUsed: computeUnitsConsumed,
      effectiveGasPrice,
      blockNumber: txResult?.slot ?? 0,
    };
  }

  executeContractCall(
    _signer: ethers.Signer,
    _request: ContractCallRequest,
    _session: NonceSession,
    _options: TransactionOptions
  ): Promise<TransactionReceipt> {
    return Promise.reject(
      new Error(
        "[SolanaChainAdapter] executeContractCall is not supported on Solana. Solana programs use instruction data, not ABI-encoded calls."
      )
    );
  }

  readContract(
    _rpcManager: RpcProviderManager,
    _request: ReadContractRequest
  ): Promise<unknown> {
    return Promise.reject(
      new Error(
        "[SolanaChainAdapter] readContract is not supported on Solana. Solana does not use ABI-encoded view functions."
      )
    );
  }

  async getBalance(
    _rpcManager: RpcProviderManager | undefined,
    address: string
  ): Promise<bigint> {
    const pubkey = new PublicKey(address);
    const manager = await this.getManager();
    return manager.executeWithFailover(async (connection) => {
      const lamports = await connection.getBalance(pubkey);
      return BigInt(lamports);
    });
  }

  executeWithFailover<T>(
    _rpcManager: RpcProviderManager,
    _operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
    _operationType?: "read" | "write"
  ): Promise<T> {
    return Promise.reject(
      new Error(
        "[SolanaChainAdapter] executeWithFailover via RpcProviderManager is not supported on Solana. " +
          "Cast to SolanaChainAdapter and call executeWithSolanaFailover instead."
      )
    );
  }

  async executeWithSolanaFailover<T>(
    operation: (connection: Connection) => Promise<T>,
    operationType?: RpcOperationType
  ): Promise<T> {
    const manager = await this.getManager();
    return manager.executeWithFailover(operation, operationType);
  }

  // The explorer URL is cosmetic. A failure building it (e.g. the explorer-config
  // lookup throwing) must never propagate: by the time a transfer step calls this
  // the transaction is already on-chain, and a throw here would flip a completed
  // transfer's result to failed. Callers treat "" as "no link available".
  async getTransactionUrl(txHash: string): Promise<string> {
    try {
      return await buildChainTransactionUrl(this.chainId, txHash);
    } catch (error) {
      logWarn(
        `[SolanaChainAdapter] Failed to build transaction explorer URL: ${getErrorMessage(error)}`,
        { chain_id: String(this.chainId) }
      );
      return "";
    }
  }

  async getAddressUrl(address: string): Promise<string> {
    try {
      return await buildChainAddressUrl(this.chainId, address);
    } catch (error) {
      logWarn(
        `[SolanaChainAdapter] Failed to build address explorer URL: ${getErrorMessage(error)}`,
        { chain_id: String(this.chainId) }
      );
      return "";
    }
  }
}
