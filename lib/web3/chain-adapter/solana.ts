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

  async sendTransaction(
    _signer: ethers.Signer, // Unused: Solana uses options.solanaSigner
    request: SendTransactionRequest,
    _session: NonceSession, // Unused: Solana has no EVM nonce concept
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    if (!options.solanaSigner) {
      throw new Error("[SolanaChainAdapter] Missing options.solanaSigner");
    }

    // Capture in a non-nullable local so TypeScript can narrow it inside
    // the executeWithFailover async closure (the outer guard doesn't flow in).
    const solanaSigner = options.solanaSigner;

    // Construct a real PublicKey from the duck-typed return of getPublicKey().
    // The SolanaTransactionSigner interface returns { toBase58(): string }
    // but normalizeSolanaTransaction requires the full @solana/web3.js PublicKey.
    const signerPublicKey = new PublicKey(
      (await solanaSigner.getPublicKey()).toBase58()
    );

    const { blockhash, lastValidBlockHeight } =
      await this.executeWithSolanaFailover(
        (connection) => connection.getLatestBlockhash("confirmed"),
        "read"
      );

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
        blockhash;
    } else {
      (normalized.transaction as Transaction).recentBlockhash = blockhash;
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
      // Read before simulating, so a deposit landing between the two reads
      // shrinks the apparent outflow. The gap cannot be closed from here: the
      // simulation exposes only post-state, and no RPC pins a balance read to
      // the exact slot the simulation was evaluated against. It fails in the
      // permissive direction, so this ceiling is a preflight guard rather than
      // a settlement figure; the true delta is only knowable after
      // confirmation.
      const preBalance = enforceMaxSol
        ? BigInt(await connection.getBalance(signerPublicKey))
        : BigInt(0);

      // Ask for the fee payer's simulated post-state by address on both
      // branches, so the account of interest is always at index 0.
      //
      // Requesting it is not optional on the versioned branch: a legacy
      // transaction deserializes into a VersionedTransaction wrapping a legacy
      // Message rather than throwing, so every prebuilt transaction reaches
      // this branch and an omitted `accounts` config leaves the maxSol check
      // with nothing to read.
      //
      // Addressing by key also avoids indexing into the response by the
      // transaction's own account-key position, which does not line up: the
      // legacy RPC returns only nonProgramIds, not the full key list.
      const simResult = isVersioned
        ? await connection.simulateTransaction(
            signedTx as VersionedTransaction,
            {
              sigVerify: false,
              replaceRecentBlockhash: false,
              ...(enforceMaxSol
                ? {
                    accounts: {
                      encoding: "base64" as const,
                      addresses: [signerPublicKey.toBase58()],
                    },
                  }
                : {}),
            }
          )
        : await connection.simulateTransaction(
            signedTx as Transaction,
            undefined,
            enforceMaxSol ? [signerPublicKey] : undefined
          );

      if (simResult.value.err) {
        throw new Error(
          `[SolanaChainAdapter] Simulation failed: ${JSON.stringify(simResult.value.err)}`
        );
      }

      if (enforceMaxSol && options.maxSolLamports !== undefined) {
        // A fee payer absent from the transaction simulates to a null entry
        // here, which lands in the same branch as a missing account state.
        const postLamports = simResult.value.accounts?.[0]?.lamports;
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

    const manager = await this.getManager();
    const { signature } = await submitSignedSolanaTransactionWithFailover(
      signedBytes,
      manager
    );

    const { confirmationErr, txResult } = await this.executeWithSolanaFailover(
      async (connection) => {
        const confirmation = await connection.confirmTransaction(
          {
            signature,
            blockhash, // Original blockhash used for signing
            lastValidBlockHeight,
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

    // A Solana transaction that fails execution still "confirms" - it lands
    // on-chain with an error set. confirmation.value.err is authoritative:
    // never report a failed tx as a successful receipt (mirrors the EVM
    // adapter's receipt.status === 0 guard). These checks run outside the
    // failover closure so a genuinely-failed tx is not retried. getTransaction
    // may still be null from propagation lag after a successful confirm (an
    // accounting gap, not a failure), but if present with meta.err it reverted.
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
