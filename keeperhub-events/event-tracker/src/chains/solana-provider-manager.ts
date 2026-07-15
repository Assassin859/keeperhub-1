import {
  type Commitment,
  type ConfirmedSignatureInfo,
  Connection,
  type Finality,
  PublicKey,
  type SignaturesForAddressOptions,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { logger } from "../../lib/utils/logger";
import type { ChainHealth, Unsubscribe } from "./provider-manager";

export type { Unsubscribe } from "./provider-manager";

/**
 * Solana analog of ChainProviderManager. One shared web3.js Connection per
 * chain provides both the WS slot subscription (the block-tick) and the HTTP
 * reads (getSignaturesForAddress / getTransaction), demuxed across every
 * SolanaEventListener on that chain.
 *
 * web3.js manages the low-level WS reconnect internally, so the reconnect
 * concern here is a *stalled* subscription: a socket that stays open but stops
 * delivering slots. A staleness watchdog rebuilds the Connection and rotates
 * primary <-> fallback endpoints when no slot arrives within the timeout -
 * the same failure mode the EVM manager's block-staleness watchdog covers.
 */

const SLOT_STALENESS_CHECK_MS = 15_000;
const SLOT_STALENESS_TIMEOUT_MS = 60_000;
const READ_MAX_ATTEMPTS = 2;
const CONNECTION_COMMITMENT: Commitment = "confirmed";

export type SlotHandler = (slot: number) => void | Promise<void>;

/**
 * The historical read RPCs (getSignaturesForAddress / getTransaction) only
 * accept Finality ("confirmed" | "finalized"). Map the lighter "processed"
 * commitment up to "confirmed" so a processed-level trigger config still reads.
 */
function toFinality(commitment: Commitment): Finality {
  return commitment === "finalized" ? "finalized" : "confirmed";
}

interface Endpoint {
  rpcUrl: string;
  wssUrl: string;
}

export interface SolanaSubscribeOptions {
  chainId: number;
  rpcUrl: string;
  fallbackRpcUrl?: string;
  wssUrl: string;
  fallbackWssUrl?: string;
  handler: SlotHandler;
}

interface ChainEntry {
  chainId: number;
  endpoints: Endpoint[];
  activeEndpointIndex: number;
  connection: Connection | null;
  slotSubscriptionId: number | null;
  handlers: Set<SlotHandler>;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  lastSlotAt: number | null;
  reconnecting: boolean;
  lastError: string | null;
}

export class SolanaProviderManager {
  private readonly entries = new Map<number, ChainEntry>();

  subscribeToSlots(opts: SolanaSubscribeOptions): Unsubscribe {
    const entry = this.getOrCreateEntry(opts);
    entry.handlers.add(opts.handler);
    return () => {
      entry.handlers.delete(opts.handler);
      if (entry.handlers.size === 0) {
        this.teardownEntry(entry);
      }
    };
  }

  /**
   * The Connection for a chain, created lazily. Throws if no listener has
   * subscribed for the chain yet (reads only happen from inside a started
   * listener, so the entry always exists by then).
   */
  private getConnection(chainId: number): Connection {
    const entry = this.entries.get(chainId);
    if (!entry) {
      throw new Error(
        `[solana-provider] no chain entry for ${chainId}; subscribe before reading`,
      );
    }
    if (!entry.connection) {
      entry.connection = this.createConnection(entry);
    }
    return entry.connection;
  }

  async getSignaturesForAddress(
    chainId: number,
    address: string,
    options: SignaturesForAddressOptions,
    commitment: Commitment,
  ): Promise<ConfirmedSignatureInfo[]> {
    const programId = new PublicKey(address);
    return this.withReadFailover(chainId, (connection) =>
      connection.getSignaturesForAddress(
        programId,
        options,
        toFinality(commitment),
      ),
    );
  }

  async getTransaction(
    chainId: number,
    signature: string,
    commitment: Commitment,
  ): Promise<VersionedTransactionResponse | null> {
    return this.withReadFailover(chainId, (connection) =>
      connection.getTransaction(signature, {
        commitment: toFinality(commitment),
        maxSupportedTransactionVersion: 0,
      }),
    );
  }

  getAllHealth(): ChainHealth[] {
    const health: ChainHealth[] = [];
    for (const entry of this.entries.values()) {
      const active = entry.endpoints[entry.activeEndpointIndex];
      const fallback = entry.endpoints.length > 1 ? entry.endpoints[1] : null;
      health.push({
        chainId: entry.chainId,
        wssUrl: active?.wssUrl ?? "",
        fallbackWssUrl: fallback?.wssUrl ?? null,
        connected: entry.slotSubscriptionId !== null && !entry.reconnecting,
        reconnecting: entry.reconnecting,
        lastBlockAt: entry.lastSlotAt,
        subscriberCount: entry.handlers.size,
        lastCreateError: entry.lastError,
      });
    }
    return health;
  }

  async destroy(): Promise<void> {
    for (const entry of this.entries.values()) {
      this.teardownEntry(entry);
    }
    this.entries.clear();
  }

  private getOrCreateEntry(opts: SolanaSubscribeOptions): ChainEntry {
    const existing = this.entries.get(opts.chainId);
    if (existing) {
      return existing;
    }
    const endpoints: Endpoint[] = [
      { rpcUrl: opts.rpcUrl, wssUrl: opts.wssUrl },
    ];
    if (opts.fallbackRpcUrl && opts.fallbackWssUrl) {
      endpoints.push({
        rpcUrl: opts.fallbackRpcUrl,
        wssUrl: opts.fallbackWssUrl,
      });
    }
    const entry: ChainEntry = {
      chainId: opts.chainId,
      endpoints,
      activeEndpointIndex: 0,
      connection: null,
      slotSubscriptionId: null,
      handlers: new Set(),
      watchdogTimer: null,
      lastSlotAt: null,
      reconnecting: false,
      lastError: null,
    };
    this.entries.set(opts.chainId, entry);
    this.startSlotSubscription(entry);
    return entry;
  }

  private createConnection(entry: ChainEntry): Connection {
    const endpoint = entry.endpoints[entry.activeEndpointIndex];
    return new Connection(endpoint.rpcUrl, {
      wsEndpoint: endpoint.wssUrl,
      commitment: CONNECTION_COMMITMENT,
    });
  }

  private startSlotSubscription(entry: ChainEntry): void {
    try {
      const connection = this.getConnection(entry.chainId);
      entry.slotSubscriptionId = connection.onSlotChange((slotInfo) => {
        entry.lastSlotAt = Date.now();
        entry.lastError = null;
        for (const handler of entry.handlers) {
          void Promise.resolve(handler(slotInfo.slot)).catch((err) => {
            logger.warn(
              `[solana-provider] chain ${entry.chainId} slot handler error: ${String(err)}`,
            );
          });
        }
      });
      entry.lastSlotAt = Date.now();
      entry.reconnecting = false;
      if (!entry.watchdogTimer) {
        entry.watchdogTimer = setInterval(
          () => this.checkSlotStaleness(entry),
          SLOT_STALENESS_CHECK_MS,
        );
      }
      logger.log(
        `[solana-provider] chain ${entry.chainId} slot subscription started on ${entry.endpoints[entry.activeEndpointIndex].wssUrl}`,
      );
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[solana-provider] chain ${entry.chainId} failed to start slot subscription: ${entry.lastError}`,
      );
    }
  }

  private checkSlotStaleness(entry: ChainEntry): void {
    if (entry.reconnecting || entry.lastSlotAt === null) {
      return;
    }
    const age = Date.now() - entry.lastSlotAt;
    if (age > SLOT_STALENESS_TIMEOUT_MS) {
      logger.warn(
        `[solana-provider] chain ${entry.chainId} slot stream stale (${age}ms); rebuilding`,
      );
      this.rebuildConnection(entry);
    }
  }

  private rebuildConnection(entry: ChainEntry): void {
    entry.reconnecting = true;
    this.removeSlotSubscription(entry);
    entry.connection = null;
    // Rotate to the next endpoint so a dead primary flips to the fallback
    // (and back), mirroring the EVM manager's primary/fallback failover.
    if (entry.endpoints.length > 1) {
      entry.activeEndpointIndex =
        (entry.activeEndpointIndex + 1) % entry.endpoints.length;
    }
    this.startSlotSubscription(entry);
  }

  private async withReadFailover<T>(
    chainId: number,
    operation: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < READ_MAX_ATTEMPTS; attempt++) {
      const connection = this.getConnection(chainId);
      try {
        return await operation(connection);
      } catch (err) {
        lastError = err;
        const entry = this.entries.get(chainId);
        if (entry && entry.endpoints.length > 1) {
          entry.activeEndpointIndex =
            (entry.activeEndpointIndex + 1) % entry.endpoints.length;
          entry.connection = null;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private removeSlotSubscription(entry: ChainEntry): void {
    if (entry.slotSubscriptionId !== null && entry.connection) {
      const connection = entry.connection;
      const id = entry.slotSubscriptionId;
      void connection.removeSlotChangeListener(id).catch(() => {
        // Best-effort: the socket may already be gone. The dropped reference
        // lets web3.js close the underlying WS when no subscriptions remain.
      });
    }
    entry.slotSubscriptionId = null;
  }

  private teardownEntry(entry: ChainEntry): void {
    if (entry.watchdogTimer) {
      clearInterval(entry.watchdogTimer);
      entry.watchdogTimer = null;
    }
    this.removeSlotSubscription(entry);
    entry.connection = null;
    this.entries.delete(entry.chainId);
    logger.log(`[solana-provider] chain ${entry.chainId} torn down`);
  }
}

/**
 * Process-wide singleton, mirroring `chainProviderManager`. One Connection per
 * Solana chain, shared by every SolanaEventListener.
 */
export const solanaProviderManager = new SolanaProviderManager();
