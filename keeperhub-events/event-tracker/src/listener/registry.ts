import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Commitment } from "@solana/web3.js";
import { logger } from "../../lib/utils/logger";
import type { ChainProviderManager } from "../chains/provider-manager";
import type { SolanaProviderManager } from "../chains/solana-provider-manager";
import type { AbiEvent } from "../chains/validation";
import type { DedupStore } from "./dedup";
import { EventListener } from "./event-listener";
import { formatError } from "./format-error";
import { SolanaEventListener } from "./solana-event-listener";
import type { Listener } from "./types";

/**
 * In-process registry of listener instances, keyed by workflow ID. The
 * reconciler diffs the active workflow list against this registry and calls
 * add/remove to converge.
 *
 * Holds both EVM and Solana listeners behind the common `Listener` interface.
 * EVM listeners share one ChainProviderManager (one WSS per chain); Solana
 * listeners share one SolanaProviderManager (one Connection per chain). All
 * listeners share one DedupStore.
 *
 * Deliberately does not import the concrete `RedisDedupStore` factory so that
 * this module can be loaded by unit tests without requiring `ioredis` at the
 * test runtime. Production wiring of the factory lives in `factory.ts`.
 */

interface RegistrationBase {
  workflowId: string;
  userId: string;
  workflowName: string;
  chainId: number;
  /**
   * Stable hash over the listener-affecting fields of this registration.
   * Produced by `workflow-mapper` and used by the reconciler to detect config
   * changes (contract/program swap, event rename, ABI/IDL update, user
   * reassignment) and restart the listener rather than leave it running with
   * stale config.
   */
  configHash: string;
}

export interface EvmWorkflowRegistration extends RegistrationBase {
  kind: "evm";
  wssUrl: string;
  /**
   * Optional secondary WSS endpoint. If primary is unreachable or rejects
   * `eth_subscribe`, ChainProviderManager falls through to this URL before
   * giving up. Populated from `chains.default_fallback_wss` when it parses
   * as a valid `ws://` / `wss://` URL.
   */
  fallbackWssUrl?: string;
  contractAddress: string;
  eventName: string;
  eventsAbiStrings: string[];
  rawEventsAbi: AbiEvent[];
}

export interface SolanaWorkflowRegistration extends RegistrationBase {
  kind: "solana";
  /** HTTP RPC for getSignaturesForAddress / getTransaction reads. */
  rpcUrl: string;
  fallbackRpcUrl?: string;
  /** WSS for the slotSubscribe block-tick. */
  wssUrl: string;
  fallbackWssUrl?: string;
  programId: string;
  commitment: Commitment;
  /** Anchor IDL JSON for typed decoding; absent -> raw log mode. */
  idl?: string;
  /** Anchor event name to match in typed mode; absent -> fire on any tx. */
  eventName?: string;
}

export type WorkflowRegistration =
  | EvmWorkflowRegistration
  | SolanaWorkflowRegistration;

export interface RegistryDeps {
  providerManager: ChainProviderManager;
  solanaProviderManager: SolanaProviderManager;
  dedup: DedupStore;
  sqs: SQSClient;
  sqsQueueUrl: string;
}

interface RegistryEntry {
  listener: Listener;
  configHash: string;
}

export class ListenerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
  }

  /**
   * Not concurrency-safe against interleaved `remove(workflowId)` calls for
   * the same id. The has() check and the final `entries.set` straddle an
   * `await` on `listener.start()`, so a `remove` that lands in that window
   * sees nothing to remove, the add completes, and a zombie listener is left
   * registered.
   *
   * The reconciler calls `add` and `remove` from a single sequential loop
   * inside `synchronizeData`, so this race cannot be observed in the
   * production code path.
   */
  async add(reg: WorkflowRegistration): Promise<void> {
    if (this.entries.has(reg.workflowId)) {
      // Idempotent: the reconciler handles config changes via remove+add
      // rather than in-place mutation.
      return;
    }
    const listener = this.createListener(reg);
    try {
      await listener.start();
    } catch (err) {
      logger.warn(
        `[ListenerRegistry] failed to start listener ${reg.workflowId}: ${formatError(err)}`,
      );
      return;
    }
    this.entries.set(reg.workflowId, {
      listener,
      configHash: reg.configHash,
    });
  }

  private createListener(reg: WorkflowRegistration): Listener {
    if (reg.kind === "solana") {
      return new SolanaEventListener({
        ...reg,
        sqs: this.deps.sqs,
        sqsQueueUrl: this.deps.sqsQueueUrl,
        dedup: this.deps.dedup,
        providerManager: this.deps.solanaProviderManager,
      });
    }
    return new EventListener({
      ...reg,
      providerManager: this.deps.providerManager,
      dedup: this.deps.dedup,
      sqs: this.deps.sqs,
      sqsQueueUrl: this.deps.sqsQueueUrl,
    });
  }

  remove(workflowId: string): void {
    const entry = this.entries.get(workflowId);
    if (!entry) {
      return;
    }
    entry.listener.stop();
    this.entries.delete(workflowId);
  }

  has(workflowId: string): boolean {
    return this.entries.has(workflowId);
  }

  /**
   * Returns the configHash stored when the listener was registered, or
   * `undefined` if no listener is registered under that id. Callers compare
   * this to a fresh registration's configHash to detect workflow config
   * changes and trigger a remove+add restart.
   */
  getConfigHash(workflowId: string): string | undefined {
    return this.entries.get(workflowId)?.configHash;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  size(): number {
    return this.entries.size;
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.listener.stop();
    }
    this.entries.clear();
  }
}
