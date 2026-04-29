import { ethers } from "ethers";
import { logger } from "../../lib/utils/logger";

/**
 * ChainProviderManager centralises WebSocket provider ownership and
 * block-based log delivery per chain. One provider and one
 * `eth_subscribe(newHeads)` subscription per chainId, regardless of how
 * many listeners are registered for that chain.
 *
 * Log delivery uses block subscription + batched `eth_getLogs` rather than
 * one `eth_subscribe(logs, ...)` per listener. This decouples RPC-side
 * subscription count from workflow count (provider subscription caps are
 * typically ~1000 per WSS).
 *
 * Per-chain reconnect + heartbeat are owned here. Drop detection uses two
 * signals:
 *   - `provider.on("error")` for transport-level errors surfaced by ethers
 *   - An active heartbeat that pings `eth_blockNumber` every
 *     `HEARTBEAT_INTERVAL_MS` with a `HEARTBEAT_TIMEOUT_MS` cap
 *
 * A passive `websocket.on("close")` hook was considered but rejected: it
 * reaches into `(provider as any).websocket`, breaks between ethers
 * versions, and adds no detection we do not already get from the
 * heartbeat. Detection latency is bounded by heartbeat cadence, which is
 * tuneable via the constants below.
 *
 * On drop: fire registered `onDisconnect` handlers, then attempt reconnect
 * with exponential backoff. On exhaustion: call the injected
 * `onPermanentFailure` callback (defaults to `process.exit(1)` so K8s
 * restarts the pod - tests inject a no-op).
 */

// Address list cap on `eth_getLogs` varies by provider (Alchemy ~500,
// Infura ~1000). Chunk defensively; multiple calls per block are cheap.
const GETLOGS_ADDRESS_BATCH = 500;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export type LogHandler = (log: ethers.Log) => void | Promise<void>;
export type Unsubscribe = () => void;

export type ProviderFactory = (wssUrl: string) => ethers.WebSocketProvider;

export type DisconnectReason =
  | "provider_error"
  | "heartbeat_failure"
  | "heartbeat_timeout";

export interface DisconnectEvent {
  chainId: number;
  reason: DisconnectReason;
  message: string;
}

export type DisconnectHandler = (ev: DisconnectEvent) => void | Promise<void>;

export interface ChainHealth {
  chainId: number;
  wssUrl: string;
  connected: boolean;
  reconnecting: boolean;
  lastBlockAt: number | null;
  subscriberCount: number;
}

export interface SubscribeOptions {
  chainId: number;
  wssUrl: string;
  address: string;
  topic0: string;
  handler: LogHandler;
}

export interface ChainProviderManagerOptions {
  factory?: ProviderFactory;
  onPermanentFailure?: (chainId: number) => void;
}

interface Subscriber {
  address: string; // normalized to lowercase
  topic0: string; // 0x-prefixed, lowercase
  handler: LogHandler;
}

interface ChainEntry {
  chainId: number;
  wssUrl: string;
  provider: ethers.WebSocketProvider | null;
  readyPromise: Promise<ethers.WebSocketProvider> | null;
  /**
   * Live while a reconnect loop is running. Callers awaiting a provider
   * (`getOrCreateProvider`) must wait on this first so they do not fire a
   * second `createProvider` that races with the reconnect's own factory
   * call and produces two parallel providers on the same chain.
   */
  reconnectPromise: Promise<void> | null;
  subscribers: Set<Subscriber>;
  blockListener: ((blockNumber: number) => Promise<void>) | null;
  errorListener: ((err: Error) => void) | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  isReconnecting: boolean;
  lastBlockAt: number | null;
  disconnectHandlers: Set<DisconnectHandler>;
}

const defaultFactory: ProviderFactory = (wssUrl) =>
  new ethers.WebSocketProvider(wssUrl);

const defaultOnPermanentFailure = (chainId: number): void => {
  logger.error(
    `[ChainProviderManager] chain=${chainId} permanent failure after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts; exiting process for K8s restart`,
  );
  process.exit(1);
};

export class ChainProviderManager {
  private readonly chains = new Map<number, ChainEntry>();
  private readonly factory: ProviderFactory;
  private readonly onPermanentFailure: (chainId: number) => void;
  private isDestroyed = false;
  // Wake-up signal for in-flight reconnect sleeps: `destroy()` resolves
  // this promise, racing any pending backoff sleep so the reconnect loop
  // checks `isDestroyed` and bails promptly instead of waiting out its
  // full delay. Without this, `destroy()` hangs when tests switch from
  // fake to real timers with a fake-timer sleep still pending.
  private readonly destroyed: {
    promise: Promise<void>;
    resolve: () => void;
  };

  constructor(opts: ChainProviderManagerOptions = {}) {
    this.factory = opts.factory ?? defaultFactory;
    this.onPermanentFailure =
      opts.onPermanentFailure ?? defaultOnPermanentFailure;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.destroyed = { promise, resolve };
  }

  async getOrCreateProvider(
    chainId: number,
    wssUrl: string,
  ): Promise<ethers.WebSocketProvider> {
    const entry = this.ensureEntry(chainId, wssUrl);

    // If a reconnect loop is live, wait for it to settle before checking
    // the provider. Without this, a new subscriber arriving while the
    // old provider has been torn down but the new one is not yet
    // assigned races the reconnect's factory call and produces a second
    // orphaned provider.
    if (entry.reconnectPromise) {
      await entry.reconnectPromise;
    }

    if (entry.provider) {
      return entry.provider;
    }

    // Two concurrent callers must receive the same provider instance, not
    // race to create separate ones.
    if (!entry.readyPromise) {
      entry.readyPromise = this.createProvider(entry);
    }
    return entry.readyPromise;
  }

  async subscribeToLogs(opts: SubscribeOptions): Promise<Unsubscribe> {
    const entry = this.ensureEntry(opts.chainId, opts.wssUrl);
    await this.getOrCreateProvider(opts.chainId, opts.wssUrl);

    const subscriber: Subscriber = {
      address: opts.address.toLowerCase(),
      topic0: opts.topic0.toLowerCase(),
      handler: opts.handler,
    };
    entry.subscribers.add(subscriber);

    // Block listener and heartbeat are lifecycle-tied to subscribers:
    // attach on the first, detach on the last. Heartbeat on an idle
    // provider is wasted RPC calls, so creating a provider via bare
    // `getOrCreateProvider` without subscribing leaves it silent until
    // the first subscribe. Key off `!entry.blockListener` rather than
    // "was this the first subscriber" so that a fresh provider created
    // after a permanent-failure + test-injected no-op + resubscribe
    // still gets wired up correctly.
    if (!entry.blockListener) {
      this.attachBlockListener(entry);
      this.startHeartbeat(entry);
    }

    return () => {
      entry.subscribers.delete(subscriber);
      if (entry.subscribers.size === 0) {
        this.detachBlockListener(entry);
        this.stopHeartbeat(entry);
      }
    };
  }

  /**
   * Register a handler that fires when the manager detects a transport
   * drop for `chainId`. Fires once per drop, before reconnect begins.
   * Throws if no ChainEntry exists yet for the chain (call
   * `subscribeToLogs` or `getOrCreateProvider` first).
   */
  onDisconnect(chainId: number, handler: DisconnectHandler): Unsubscribe {
    const entry = this.chains.get(chainId);
    if (!entry) {
      throw new Error(
        `onDisconnect: no entry for chainId ${chainId}; call subscribeToLogs or getOrCreateProvider first`,
      );
    }
    entry.disconnectHandlers.add(handler);
    return () => {
      entry.disconnectHandlers.delete(handler);
    };
  }

  /**
   * True iff a provider instance has been created for `chainId`. Intended
   * for tests that need to assert the shared-provider invariant
   * (N listeners on chain X share one provider).
   */
  hasProvider(chainId: number): boolean {
    return this.chains.get(chainId)?.provider != null;
  }

  /**
   * Number of active subscribers for `chainId`. Returns 0 for an unknown
   * chain. Used by tests to assert that multiple listeners on the same
   * chain multiplex through one ChainEntry (the demux path).
   */
  subscriberCount(chainId: number): number {
    return this.chains.get(chainId)?.subscribers.size ?? 0;
  }

  /**
   * Returns true iff the manager has an active provider for `chainId`
   * and is not currently reconnecting. Deliberately asymmetric with the
   * `/healthz` endpoint's "no chains registered = 200 OK" rule: per-chain
   * `isHealthy` answers *"do I affirmatively know this chain is up"* (so
   * unknown chains return false), while `/healthz` answers *"is the
   * system degraded"* (so zero chains is not a degradation).
   */
  isHealthy(chainId: number): boolean {
    const entry = this.chains.get(chainId);
    if (!entry) {
      return false;
    }
    return entry.provider != null && !entry.isReconnecting;
  }

  getHealth(chainId: number): ChainHealth | null {
    const entry = this.chains.get(chainId);
    if (!entry) {
      return null;
    }
    return {
      chainId: entry.chainId,
      wssUrl: entry.wssUrl,
      connected: entry.provider != null && !entry.isReconnecting,
      reconnecting: entry.isReconnecting,
      lastBlockAt: entry.lastBlockAt,
      subscriberCount: entry.subscribers.size,
    };
  }

  getAllHealth(): ChainHealth[] {
    const out: ChainHealth[] = [];
    for (const entry of this.chains.values()) {
      out.push({
        chainId: entry.chainId,
        wssUrl: entry.wssUrl,
        connected: entry.provider != null && !entry.isReconnecting,
        reconnecting: entry.isReconnecting,
        lastBlockAt: entry.lastBlockAt,
        subscriberCount: entry.subscribers.size,
      });
    }
    return out;
  }

  async destroy(): Promise<void> {
    this.isDestroyed = true;
    // Wake every reconnect loop that is currently sleeping. The loop
    // resumes, checks `isDestroyed`, and bails via its `finally`.
    this.destroyed.resolve();
    const errors: unknown[] = [];
    for (const entry of this.chains.values()) {
      // Wait for any in-flight reconnect loop to settle before tearing
      // the entry down. The loop observes `isDestroyed` at its next
      // check and bails; `reconnectPromise` is the .catch-wrapped form
      // so it never rejects. Without this await, destroy() could
      // resolve while the loop is still running its teardown code,
      // leading to observable races in tests.
      if (entry.reconnectPromise) {
        await entry.reconnectPromise;
      }
      this.stopHeartbeat(entry);
      this.detachBlockListener(entry);
      this.detachErrorListener(entry);
      if (entry.provider) {
        try {
          await entry.provider.destroy();
        } catch (err) {
          errors.push(err);
        }
      }
      entry.subscribers.clear();
      entry.disconnectHandlers.clear();
      entry.provider = null;
      entry.readyPromise = null;
    }
    this.chains.clear();
    if (errors.length > 0) {
      logger.warn(
        `[ChainProviderManager] ${errors.length} provider destroy errors: ${errors
          .map(String)
          .join("; ")}`,
      );
    }
  }

  private ensureEntry(chainId: number, wssUrl: string): ChainEntry {
    const existing = this.chains.get(chainId);
    if (existing) {
      if (existing.wssUrl !== wssUrl) {
        throw new Error(
          `chainId ${chainId} already registered with wssUrl ${existing.wssUrl}; refusing to reuse for ${wssUrl}`,
        );
      }
      return existing;
    }
    const entry: ChainEntry = {
      chainId,
      wssUrl,
      provider: null,
      readyPromise: null,
      reconnectPromise: null,
      subscribers: new Set(),
      blockListener: null,
      errorListener: null,
      heartbeatTimer: null,
      isReconnecting: false,
      lastBlockAt: null,
      disconnectHandlers: new Set(),
    };
    this.chains.set(chainId, entry);
    return entry;
  }

  private async createProvider(
    entry: ChainEntry,
  ): Promise<ethers.WebSocketProvider> {
    const provider = this.factory(entry.wssUrl);
    await provider.ready;
    entry.provider = provider;
    this.attachErrorListener(entry);
    // Heartbeat is subscriber-scoped (started on first subscribe, stopped
    // on last unsubscribe) to avoid wasted pings on an idle chain.
    return provider;
  }

  private attachBlockListener(entry: ChainEntry): void {
    if (!entry.provider) {
      throw new Error(
        `attachBlockListener: provider not initialized for chain ${entry.chainId}`,
      );
    }
    const listener = async (blockNumber: number): Promise<void> => {
      entry.lastBlockAt = Date.now();
      await this.processBlock(entry, blockNumber);
    };
    entry.blockListener = listener;
    entry.provider.on("block", listener);
  }

  private detachBlockListener(entry: ChainEntry): void {
    if (!(entry.provider && entry.blockListener)) {
      entry.blockListener = null;
      return;
    }
    entry.provider.off("block", entry.blockListener);
    entry.blockListener = null;
  }

  private attachErrorListener(entry: ChainEntry): void {
    if (!entry.provider) {
      return;
    }
    const listener = (err: Error): void => {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} provider error: ${err.message}`,
      );
      this.triggerReconnect(entry, "provider_error", err.message);
    };
    entry.errorListener = listener;
    entry.provider.on("error", listener);
  }

  private detachErrorListener(entry: ChainEntry): void {
    if (!(entry.provider && entry.errorListener)) {
      entry.errorListener = null;
      return;
    }
    entry.provider.off("error", entry.errorListener);
    entry.errorListener = null;
  }

  private startHeartbeat(entry: ChainEntry): void {
    this.stopHeartbeat(entry);
    entry.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat(entry);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(entry: ChainEntry): void {
    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
  }

  private async runHeartbeat(entry: ChainEntry): Promise<void> {
    if (this.isDestroyed || entry.isReconnecting || !entry.provider) {
      return;
    }
    try {
      await Promise.race([
        entry.provider.send("eth_blockNumber", []),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("heartbeat timeout")),
            HEARTBEAT_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason: DisconnectReason =
        message === "heartbeat timeout"
          ? "heartbeat_timeout"
          : "heartbeat_failure";
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} heartbeat failed: ${message}`,
      );
      this.triggerReconnect(entry, reason, message);
    }
  }

  private triggerReconnect(
    entry: ChainEntry,
    reason: DisconnectReason,
    message: string,
  ): void {
    if (this.isDestroyed || entry.isReconnecting) {
      return;
    }
    entry.isReconnecting = true;
    this.stopHeartbeat(entry);

    // Publish the reconnect promise on the entry BEFORE any `await`
    // yields. `getOrCreateProvider` awaits this to avoid creating a
    // second parallel provider while the reconnect is replacing the
    // first. State is cleared inside `reconnectLoop`'s `finally` so it
    // happens synchronously with the promise settling - a follow-up
    // error on the newly-attached provider will see
    // `isReconnecting === false` by the time the prior loop has
    // resolved, rather than racing an outer `.finally`.
    // `.catch` so the stored promise never rejects: any bug surfaces
    // via the logger, not via an await that callers have to handle.
    entry.reconnectPromise = this.reconnectLoop(entry, reason, message).catch(
      (err) => {
        logger.error(
          `[ChainProviderManager] chain=${entry.chainId} reconnect loop crashed: ${String(err)}`,
        );
      },
    );
  }

  private async reconnectLoop(
    entry: ChainEntry,
    reason: DisconnectReason,
    message: string,
  ): Promise<void> {
    try {
      // Fire disconnect handlers in parallel before the backoff begins.
      // Sequential await here lets one slow handler delay reconnect
      // start by its latency; Promise.all matches the dispatchLog pattern.
      await Promise.all(
        [...entry.disconnectHandlers].map(async (handler) => {
          try {
            await handler({ chainId: entry.chainId, reason, message });
          } catch (err) {
            logger.warn(
              `[ChainProviderManager] chain=${entry.chainId} disconnect handler threw: ${String(err)}`,
            );
          }
        }),
      );

      let delay = INITIAL_RECONNECT_DELAY_MS;
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (this.isDestroyed) {
          return;
        }
        // Race the backoff sleep against the destroy signal so the loop
        // wakes up immediately on teardown. The isDestroyed check after
        // the race handles both paths: timer elapsed (normal) or
        // destroy resolved (early).
        await Promise.race([sleep(delay), this.destroyed.promise]);
        if (this.isDestroyed) {
          return;
        }
        try {
          await this.reconnect(entry);
          logger.log(
            `[ChainProviderManager] chain=${entry.chainId} reconnected on attempt ${attempt}`,
          );
          return;
        } catch (err) {
          logger.warn(
            `[ChainProviderManager] chain=${entry.chainId} reconnect attempt ${attempt} failed: ${String(err)}`,
          );
          delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        }
      }

      logger.error(
        `[ChainProviderManager] chain=${entry.chainId} exhausted ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
      );
      this.onPermanentFailure(entry.chainId);
    } finally {
      // Clear synchronously with the async function's return. By the
      // time the caller awaits the stored `reconnectPromise` and
      // unblocks, `isReconnecting` is already false - no window where a
      // fresh error on the new provider gets silently dropped.
      entry.reconnectPromise = null;
      entry.isReconnecting = false;
    }
  }

  private async reconnect(entry: ChainEntry): Promise<void> {
    if (this.isDestroyed) {
      return;
    }
    // Tear down the old provider (best-effort) and unhook listeners so
    // the old provider cannot trigger another reconnect while we are
    // building the new one.
    if (entry.provider) {
      this.detachBlockListener(entry);
      this.detachErrorListener(entry);
      try {
        await entry.provider.destroy();
      } catch {
        // ignore
      }
    }
    entry.provider = null;
    entry.readyPromise = null;

    if (this.isDestroyed) {
      return;
    }

    // Re-create. Any throw here propagates to the loop which handles
    // backoff.
    const provider = this.factory(entry.wssUrl);
    await provider.ready;

    // Destroy may have run while we were waiting for `ready`. If so, the
    // entry we are about to populate is no longer in `this.chains` and
    // attaching listeners would leak a provider that never gets
    // destroyed by the second pass.
    if (this.isDestroyed) {
      try {
        await provider.destroy();
      } catch {
        // ignore
      }
      return;
    }

    entry.provider = provider;

    this.attachErrorListener(entry);
    // Block listener and heartbeat only if this chain has subscribers.
    // Both are subscriber-scoped; if every subscriber unsubscribed
    // during the reconnect, the new provider stays quiet until someone
    // subscribes again.
    if (entry.subscribers.size > 0) {
      this.attachBlockListener(entry);
      this.startHeartbeat(entry);
    }
  }

  private async processBlock(
    entry: ChainEntry,
    blockNumber: number,
  ): Promise<void> {
    const subscribers = [...entry.subscribers];
    if (subscribers.length === 0 || !entry.provider) {
      return;
    }

    const { addresses, topic0s } = this.collectFilter(subscribers);
    const blockHex = `0x${blockNumber.toString(16)}`;

    try {
      const logs: ethers.Log[] = [];
      for (let i = 0; i < addresses.length; i += GETLOGS_ADDRESS_BATCH) {
        const chunk = addresses.slice(i, i + GETLOGS_ADDRESS_BATCH);
        const batch = (await entry.provider.send("eth_getLogs", [
          {
            fromBlock: blockHex,
            toBlock: blockHex,
            address: chunk,
            topics: [topic0s],
          },
        ])) as ethers.Log[];
        logs.push(...batch);
      }

      for (const log of logs) {
        await this.dispatchLog(entry, log);
      }
    } catch (err) {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} block=${blockNumber} getLogs failed: ${String(err)}`,
      );
    }
  }

  private collectFilter(subscribers: Subscriber[]): {
    addresses: string[];
    topic0s: string[];
  } {
    const addressSet = new Set<string>();
    const topicSet = new Set<string>();
    for (const sub of subscribers) {
      addressSet.add(sub.address);
      topicSet.add(sub.topic0);
    }
    return {
      addresses: [...addressSet],
      topic0s: [...topicSet],
    };
  }

  private async dispatchLog(entry: ChainEntry, log: ethers.Log): Promise<void> {
    const logAddr = log.address?.toLowerCase();
    const logTopic0 = log.topics?.[0]?.toLowerCase();
    if (!(logAddr && logTopic0)) {
      return;
    }
    // Fire all matching handlers concurrently. Sequential `await` here would
    // let a slow handler (e.g. one applying the EventListener jitter sleep)
    // stall dispatch to every other subscriber on the same log, compounding
    // latency linearly with listener count. Each handler's errors are
    // isolated so one rejection does not abort the others.
    const matching: Subscriber[] = [];
    for (const sub of entry.subscribers) {
      if (sub.address === logAddr && sub.topic0 === logTopic0) {
        matching.push(sub);
      }
    }
    await Promise.all(
      matching.map(async (sub) => {
        try {
          await sub.handler(log);
        } catch (err) {
          logger.warn(
            `[ChainProviderManager] chain=${entry.chainId} subscriber handler threw: ${String(err)}`,
          );
        }
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const chainProviderManager = new ChainProviderManager();
