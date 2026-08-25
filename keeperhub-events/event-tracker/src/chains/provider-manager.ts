import { ethers } from "ethers";
import { WebSocket } from "ws";
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
 * Request volume is driven by block rate, so a sub-second chain costs orders
 * of magnitude more than a 12 s one for the same subscriptions. Blocks from a
 * chain observed to be producing them faster than
 * `BATCHING_BLOCK_INTERVAL_THRESHOLD_MS` are coalesced into a
 * `BATCH_WINDOW_MS` window and served by a single ranged request. Cadence is
 * measured per connection rather than configured, and every chain starts out
 * dispatching per block, so a chain only leaves the historical behaviour once
 * it has demonstrated it needs to.
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
/**
 * Ceiling on the gap between delivered blocks before a subscribed chain's
 * connection is treated as dead. The heartbeat pings `eth_blockNumber`, a
 * request/response RPC call that stays healthy even when the `newHeads` push
 * subscription has silently stopped delivering blocks - so a stalled
 * subscription passes the heartbeat forever. Block-staleness is the only
 * signal that catches that state. Checked on each heartbeat tick, so
 * effective detection latency is this value plus up to one
 * HEARTBEAT_INTERVAL_MS. Defaults well above any supported chain's block
 * time so a slow-but-healthy chain is never reconnected for a normal
 * inter-block gap; overridable per-manager for tests.
 */
const BLOCK_STALENESS_TIMEOUT_MS = 120_000;
/**
 * Floor on the derived staleness threshold for a batching chain. A chain
 * producing blocks every 100 ms would otherwise derive a 1 s threshold and
 * reconnect on any brief upstream hiccup. 30 s is ~300 blocks of slack there,
 * still three orders of magnitude tighter than the fixed default.
 */
const BLOCK_STALENESS_FLOOR_MS = 30_000;
/** Blocks of slack the derived staleness threshold allows. */
const BLOCK_STALENESS_BLOCK_MULTIPLIER = 10;

/**
 * Batching engages only below this observed inter-block interval. Every chain
 * supported today produces blocks at 2 s or slower, so all of them keep the
 * historical one-`eth_getLogs`-per-block behaviour and its latency; batching
 * is reachable only by a sub-second chain, where per-block calls are the
 * problem (a 100 ms chain issues 864,000 calls/day/address-batch against
 * Base's 43,200).
 *
 * Set well clear of both sides rather than at the 1 s round number: the
 * integration rig runs anvil at `--block-time 1`, and a chain sitting exactly
 * on the threshold would drift across it on timer jitter alone and batch
 * nondeterministically. 500 ms leaves 5x margin below to the chain this
 * exists for and 2x above to the fastest cadence anything here produces.
 */
const BATCHING_BLOCK_INTERVAL_THRESHOLD_MS = 500;
/**
 * Width of the coalescing window, measured from the first buffered block.
 * Well inside the 0-10 s jitter `EventListener` already applies before
 * forwarding a matched event, so it is not the binding term in end-to-end
 * trigger latency.
 */
const BATCH_WINDOW_MS = 1_000;
/**
 * Ceiling on blocks per windowed request, so a burst (catch-up after a slow
 * flush) cannot widen the range without bound and produce an oversized
 * response or trip a provider's block-range limit.
 */
const BATCH_MAX_BLOCKS = 25;
/**
 * Inter-block intervals folded into the EWMA before its value is trusted.
 * Until then a chain dispatches per block, so a misjudged cadence at startup
 * can only fail towards today's behaviour.
 */
const BLOCK_INTERVAL_WARMUP_SAMPLES = 20;
/** EWMA smoothing factor for the inter-block interval. */
const BLOCK_INTERVAL_EWMA_ALPHA = 0.2;
/**
 * Cadence of the per-chain `getlogs-stats` line.
 *
 * Batching is a cost change, so it has to be measurable to be worth
 * trusting, and nothing outside this process can measure it. The package
 * ships no prom-client, no OpenTelemetry and no `/metrics` route, and the
 * health server binds `HEALTH_PORT` (default 3001) while the deployment
 * declares only 3000, so an endpoint added here would not be reachable.
 * Aetherlay cannot stand in either: its
 * `aetherlay_endpoint_proxy_requests_total` increments once per WebSocket
 * *connection* and only per request on the HTTP path, so calls tunnelled
 * through a long-lived socket - which is every call this class makes -
 * never move it, on any cluster.
 *
 * That leaves the log stream. `logger` emits canonical single-line JSON
 * precisely so Loki can aggregate across the app and its satellites, so a
 * periodic line is the one channel that makes calls-per-day observable.
 */
const STATS_LOG_INTERVAL_MS = 60_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;
/**
 * Cap on `eth_subscribe(["newHeads"])` round-trip during the probe in
 * `probeSubscriptionSupport`. An upstream that accepts the WS handshake
 * but never answers the JSON-RPC frame (silent backend, broken proxy) would
 * otherwise block `createProvider` forever. 10 s matches the heartbeat
 * timeout in `startHeartbeat` so the two reachability gates fail at the
 * same scale.
 */
const PROBE_TIMEOUT_MS = 10_000;
/**
 * Cap on the WS handshake + first RPC round-trip during `openProvider`.
 * `getBlockNumber()` internally calls ethers' `_waitUntilReady()`, which
 * resolves on socket open but never rejects on socket failure - so a host
 * that DNS-fails or refuses the TCP connect would otherwise hang the
 * connect attempt indefinitely. Matches `PROBE_TIMEOUT_MS` so both
 * connect-time reachability gates fail at the same scale.
 */
const CONNECT_TIMEOUT_MS = 10_000;

export type LogHandler = (log: ethers.Log) => void | Promise<void>;
export type Unsubscribe = () => void;

export type ProviderFactory = (wssUrl: string) => ethers.WebSocketProvider;

export type DisconnectReason =
  | "provider_error"
  | "heartbeat_failure"
  | "heartbeat_timeout"
  | "block_staleness";

export interface DisconnectEvent {
  chainId: number;
  reason: DisconnectReason;
  message: string;
}

export type DisconnectHandler = (ev: DisconnectEvent) => void | Promise<void>;

export interface ChainHealth {
  chainId: number;
  /**
   * The URL the live provider was opened against, or the configured
   * primary if no provider is currently connected. Equals the configured
   * fallback when the most recent successful (re)connect landed on it;
   * resets to the configured primary during a mid-reconnect window
   * because `reconnect()` clears `activeWssUrl` before re-attempting.
   */
  wssUrl: string;
  /**
   * Configured fallback URL, or null if none. Surfaced so operators can
   * see whether failover capacity exists for this chain.
   */
  fallbackWssUrl: string | null;
  connected: boolean;
  reconnecting: boolean;
  lastBlockAt: number | null;
  subscriberCount: number;
  /**
   * Smoothed inter-block interval in milliseconds, or null before the
   * current connection has observed enough intervals to estimate one.
   * Per connection, like the estimate that drives batching.
   */
  blockIntervalMs: number | null;
  /**
   * Whether this chain is coalescing blocks into windowed ranged requests
   * rather than dispatching one request per block.
   */
  batching: boolean;
  /**
   * Cumulative `eth_getLogs` calls issued for this chain since the entry
   * was created, across reconnects. The same counter reported by the
   * periodic `getlogs-stats` line, surfaced here so the number is reachable
   * without log search if this endpoint ever becomes reachable.
   */
  getLogsCalls: number;
  /**
   * If the most recent `createProvider` attempt rejected, the error
   * message captured at rejection time. Cleared on the next successful
   * provider creation. Surfaces probe failures and other setup errors
   * through `/healthz` so an operator can see *why* a chain is
   * disconnected, not just that it is.
   */
  lastCreateError: string | null;
}

export interface SubscribeOptions {
  chainId: number;
  wssUrl: string;
  /**
   * Optional secondary URL tried when the primary fails at provider
   * creation or reconnect. See `ChainEntry.fallbackWssUrl`.
   */
  fallbackWssUrl?: string;
  address: string;
  topic0: string;
  handler: LogHandler;
}

export interface ChainProviderManagerOptions {
  factory?: ProviderFactory;
  onPermanentFailure?: (chainId: number) => void;
  /**
   * Override the block-staleness ceiling (defaults to
   * BLOCK_STALENESS_TIMEOUT_MS). Tests set a small value to exercise the
   * watchdog without advancing timers past the production threshold.
   */
  blockStalenessTimeoutMs?: number;
}

interface Subscriber {
  address: string; // normalized to lowercase
  topic0: string; // 0x-prefixed, lowercase
  handler: LogHandler;
}

interface ChainEntry {
  chainId: number;
  /**
   * Configured primary URL; immutable once the entry is created. Each
   * (re)connect attempt tries this first.
   */
  wssUrl: string;
  /**
   * Configured fallback URL, immutable once the entry is created. Tried
   * only when the primary attempt fails (factory throws, the connect
   * race in `openProvider` rejects, or the `eth_subscribe` probe
   * rejects). Reconnects always start over from primary so a primary
   * that recovers is preferred.
   */
  fallbackWssUrl: string | null;
  /**
   * Which URL the live provider was created from. Equal to `wssUrl` on
   * the common path, equal to `fallbackWssUrl` when the primary failed
   * at the last (re)connect, null when no provider is live.
   */
  activeWssUrl: string | null;
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
  /**
   * When the current block listener was attached. Baseline for the
   * block-staleness watchdog before the first block arrives, so a
   * connection that never delivers a single block (subscription that
   * silently failed to establish) is still caught. Null while no block
   * listener is attached.
   */
  blockListenerAttachedAt: number | null;
  /**
   * Arrival time of the previous block, used only to measure inter-block
   * intervals. Distinct from `lastBlockAt`, which survives a reconnect as the
   * staleness baseline: folding the downtime gap into the cadence estimate
   * would read a fast chain as slow. Reset on every block-listener attach.
   */
  lastBlockIntervalAt: number | null;
  /**
   * EWMA of inter-block arrival intervals in ms, or null before the first
   * interval is observed. Measured rather than configured: no per-chain block
   * time reaches this process, and an observed value needs no migration when
   * a chain is added or its cadence changes.
   */
  blockIntervalEwmaMs: number | null;
  /** Intervals folded into `blockIntervalEwmaMs` since the last attach. */
  blockIntervalSamples: number;
  /**
   * Block numbers awaiting a windowed ranged `eth_getLogs`. Non-empty only
   * while batching is engaged.
   */
  pendingBlocks: number[];
  /** Open coalescing window, started by the first block buffered into it. */
  batchTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Populated when `createProvider` rejects (most often the
   * subscription probe). Cleared on the next successful creation.
   * Surfaced through `getAllHealth` for `/healthz` consumers.
   */
  lastCreateError: string | null;
  disconnectHandlers: Set<DisconnectHandler>;
  stats: ChainStats;
}

/**
 * Per-chain request counters behind the `getlogs-stats` line. Everything
 * except `getLogsCallsTotal` is reset once reported, so a line describes the
 * interval it covers rather than needing two lines differenced.
 *
 * None of it resets on reconnect. The cadence estimate is per connection
 * because a new socket may be a different upstream; cost is per chain.
 *
 * `blocksCovered` against `getLogsCalls` is the ratio the batching exists to
 * move, and it is self-comparing: a per-block chain reports them roughly
 * equal, a batching chain reports blocks far ahead of calls. That matters
 * because there is no historical baseline for this quantity to compare a
 * later reading against - nothing has ever counted it.
 */
interface ChainStats {
  getLogsCalls: number;
  getLogsErrors: number;
  blocksCovered: number;
  ranges: number;
  logsDispatched: number;
  getLogsCallsTotal: number;
}

function newChainStats(): ChainStats {
  return {
    getLogsCalls: 0,
    getLogsErrors: 0,
    blocksCovered: 0,
    ranges: 0,
    logsDispatched: 0,
    getLogsCallsTotal: 0,
  };
}

/**
 * Wrap socket construction so we can attach an EventEmitter-style `error`
 * listener synchronously, before ethers' WebSocketProvider has had a
 * chance to assign its own `onerror`. Without this, an early ws-layer
 * error (DNS NXDOMAIN, ECONNREFUSED, non-WS server returning HTTP 200)
 * fires on a listenerless EventEmitter, gets re-thrown synchronously,
 * escapes openProvider's try/catch as `uncaughtException`, and `index.ts`
 * exits the pod - which would crashloop the whole event-tracker on a
 * misconfigured WSS URL even when a healthy fallback is configured.
 *
 * The listener is a no-op: actual error propagation happens through
 * `attachConnectErrorListener` (a second listener attached in
 * `openProvider`), which rejects the connect race that walks to the
 * fallback URL. We just need *some* error listener to be on the ws by
 * the time the connection attempt resolves so the EventEmitter does not
 * re-throw synchronously.
 */
const defaultFactory: ProviderFactory = (wssUrl) =>
  new ethers.WebSocketProvider(() => {
    const socket = new WebSocket(wssUrl);
    socket.on("error", () => {
      // intentionally empty - see comment on defaultFactory
    });
    return socket;
  });

const defaultOnPermanentFailure = (chainId: number): void => {
  logger.error(
    `[ChainProviderManager] chain=${chainId} permanent failure after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts; exiting process for K8s restart`,
  );
  process.exit(1);
};

/**
 * Returns a Promise<never> that rejects when the provider's underlying ws
 * emits "error". The no-op listener in `defaultFactory` exists only to
 * keep the EventEmitter happy and prevent uncaughtException; this listener
 * does the actual error propagation that `openProvider`'s race needs to
 * walk to the fallback URL instead of hanging on `getBlockNumber()`.
 *
 * Cast through unknown because ethers does not expose `.websocket` in its
 * public type even though it is the documented hook for direct ws access.
 * A factory that returns a provider without a usable `.websocket` (e.g. a
 * test mock) leaves this promise pending, so the race falls back to the
 * timeout - acceptable for tests, and the connect path is exercised by
 * the integration tests in `provider-manager-bad-url.test.ts`.
 */
const attachConnectErrorListener = (
  provider: ethers.WebSocketProvider,
): Promise<never> => {
  const ws = provider.websocket as unknown as {
    on?: (event: string, cb: (err: Error) => void) => void;
  };
  return new Promise<never>((_, reject) => {
    ws?.on?.("error", (err: Error) => {
      const message = err?.message ?? String(err);
      reject(new Error(`WebSocket error: ${message}`));
    });
  });
};

export class ChainProviderManager {
  private readonly chains = new Map<number, ChainEntry>();
  private readonly factory: ProviderFactory;
  private readonly onPermanentFailure: (chainId: number) => void;
  /**
   * Explicit override for the block-staleness threshold. Null means derive it
   * per chain; tests set a small value to exercise the watchdog.
   */
  private readonly blockStalenessTimeoutOverrideMs: number | null;
  /**
   * Manager-wide timer for the periodic per-chain counter line. Started with
   * the first block listener and stopped in `destroy`. Unreferenced so a
   * reporting-only timer can never hold the process open.
   */
  private statsTimer: ReturnType<typeof setInterval> | null = null;
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
    this.blockStalenessTimeoutOverrideMs = opts.blockStalenessTimeoutMs ?? null;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.destroyed = { promise, resolve };
  }

  async getOrCreateProvider(
    chainId: number,
    wssUrl: string,
    fallbackWssUrl?: string,
  ): Promise<ethers.WebSocketProvider> {
    const entry = this.ensureEntry(chainId, wssUrl, fallbackWssUrl);

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
      const created = this.createProvider(entry);
      entry.readyPromise = created;
      // Clear the cached promise on rejection so the next caller (the
      // reconciler runs every 30s in main.ts:70) retries from scratch.
      // Without this a transient probe failure or RPC hiccup permanently
      // disables the chain until pod restart - the same rejected promise
      // would be returned to every subsequent getOrCreateProvider call.
      // The check guards against clobbering a fresh attempt that another
      // caller may have already kicked off.
      created.catch((err: unknown) => {
        entry.lastCreateError =
          err instanceof Error ? err.message : String(err);
        if (entry.readyPromise === created) {
          entry.readyPromise = null;
        }
      });
    }
    return entry.readyPromise;
  }

  async subscribeToLogs(opts: SubscribeOptions): Promise<Unsubscribe> {
    const entry = this.ensureEntry(
      opts.chainId,
      opts.wssUrl,
      opts.fallbackWssUrl,
    );
    await this.getOrCreateProvider(
      opts.chainId,
      opts.wssUrl,
      opts.fallbackWssUrl,
    );

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
    return this.toHealth(entry);
  }

  getAllHealth(): ChainHealth[] {
    const out: ChainHealth[] = [];
    for (const entry of this.chains.values()) {
      out.push(this.toHealth(entry));
    }
    return out;
  }

  private toHealth(entry: ChainEntry): ChainHealth {
    return {
      chainId: entry.chainId,
      // Active URL when a provider is live, primary otherwise. Lets
      // operators see whether failover kicked in without exposing a
      // stale "active" value when nothing is connected.
      wssUrl: entry.activeWssUrl ?? entry.wssUrl,
      fallbackWssUrl: entry.fallbackWssUrl,
      connected: entry.provider != null && !entry.isReconnecting,
      reconnecting: entry.isReconnecting,
      lastBlockAt: entry.lastBlockAt,
      subscriberCount: entry.subscribers.size,
      blockIntervalMs: entry.blockIntervalEwmaMs,
      batching: this.isBatching(entry),
      getLogsCalls: entry.stats.getLogsCallsTotal,
      lastCreateError: entry.lastCreateError,
    };
  }

  async destroy(): Promise<void> {
    this.isDestroyed = true;
    this.stopStatsTimer();
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
      entry.activeWssUrl = null;
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

  private ensureEntry(
    chainId: number,
    wssUrl: string,
    fallbackWssUrl?: string,
  ): ChainEntry {
    const fallback = fallbackWssUrl ?? null;
    const existing = this.chains.get(chainId);
    if (existing) {
      // Identity is the (primary, fallback) tuple. Two callers must agree
      // on both; otherwise the second caller would silently inherit the
      // first caller's failover behaviour.
      if (existing.wssUrl !== wssUrl || existing.fallbackWssUrl !== fallback) {
        throw new Error(
          `chainId ${chainId} already registered with wssUrl=${existing.wssUrl} fallbackWssUrl=${existing.fallbackWssUrl}; refusing to reuse for wssUrl=${wssUrl} fallbackWssUrl=${fallback}`,
        );
      }
      return existing;
    }
    const entry: ChainEntry = {
      chainId,
      wssUrl,
      fallbackWssUrl: fallback,
      activeWssUrl: null,
      provider: null,
      readyPromise: null,
      reconnectPromise: null,
      subscribers: new Set(),
      blockListener: null,
      errorListener: null,
      heartbeatTimer: null,
      isReconnecting: false,
      lastBlockAt: null,
      blockListenerAttachedAt: null,
      lastBlockIntervalAt: null,
      blockIntervalEwmaMs: null,
      blockIntervalSamples: 0,
      pendingBlocks: [],
      batchTimer: null,
      lastCreateError: null,
      disconnectHandlers: new Set(),
      stats: newChainStats(),
    };
    this.chains.set(chainId, entry);
    return entry;
  }

  /**
   * Ordered list of URLs to try at (re)connect time: primary first,
   * fallback (if configured) second. Returned fresh on every call so a
   * caller can iterate without mutating entry state.
   */
  private candidateUrls(entry: ChainEntry): string[] {
    return entry.fallbackWssUrl
      ? [entry.wssUrl, entry.fallbackWssUrl]
      : [entry.wssUrl];
  }

  /**
   * Walk the candidate URL list in order, returning the first
   * `(provider, urlUsed)` pair that satisfies factory + ready + probe.
   * On failure of one URL the partially-constructed provider is
   * destroyed best-effort before moving on, so we do not leak sockets
   * across attempts. If every URL fails, throws an aggregate error
   * containing each URL's failure message.
   */
  private async openProvider(
    entry: ChainEntry,
  ): Promise<{ provider: ethers.WebSocketProvider; urlUsed: string }> {
    const urls = this.candidateUrls(entry);
    const failures: string[] = [];
    for (const url of urls) {
      let provider: ethers.WebSocketProvider | null = null;
      try {
        provider = this.factory(url);
        // Confirm the ws upgrade actually completed. `provider.ready` in
        // ethers v6 is a synchronous boolean getter, not a Promise, so
        // awaiting it tells us nothing. `getBlockNumber()` internally
        // calls `_waitUntilReady()` which waits for socket open but
        // never rejects on socket failure - so race it against an
        // explicit ws-error listener and a connect timeout, matching
        // PR #988 in keeperhub-scheduler/block-dispatcher/chain-monitor.ts.
        const wsErrorPromise = attachConnectErrorListener(provider);
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`),
              ),
            CONNECT_TIMEOUT_MS,
          );
        });
        try {
          await Promise.race([
            provider.getBlockNumber(),
            wsErrorPromise,
            timeoutPromise,
          ]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
        await this.probeSubscriptionSupport(provider, entry, url);
        return { provider, urlUsed: url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${url}: ${message}`);
        if (provider) {
          try {
            await provider.destroy();
          } catch {
            // Best-effort: socket may already be gone (probe failure
            // already destroys), and we are about to throw or move on.
          }
        }
      }
    }
    throw new Error(
      `chain ${entry.chainId}: all ${urls.length} WSS URL(s) failed:\n  ${failures.join("\n  ")}`,
    );
  }

  private async createProvider(
    entry: ChainEntry,
  ): Promise<ethers.WebSocketProvider> {
    const { provider, urlUsed } = await this.openProvider(entry);
    entry.provider = provider;
    entry.activeWssUrl = urlUsed;
    if (urlUsed !== entry.wssUrl) {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} primary failed; running on fallback ${urlUsed}`,
      );
    }
    // Clear the prior failure marker now that we have a working provider.
    // Without this, a chain that recovered after a probe failure would
    // still report `lastCreateError` indefinitely.
    entry.lastCreateError = null;
    this.attachErrorListener(entry);
    // Heartbeat is subscriber-scoped (started on first subscribe, stopped
    // on last unsubscribe) to avoid wasted pings on an idle chain.
    return provider;
  }

  /**
   * Confirm the connected RPC accepts `eth_subscribe`. Once the manager
   * calls `provider.on("block", ...)`, ethers' SocketSubscriber.start()
   * fires `eth_subscribe(["newHeads"])` and stores the resulting promise
   * on a private field with no `.catch`. An RPC that rejects subscriptions
   * (-32601 method not available, common on lightweight or HTTP-only RPCs
   * accidentally pasted into the WSS column) lets the rejection escape to
   * `process.unhandledRejection`, which crashes the pod.
   *
   * Probing here moves the failure into an awaited path: the rejection
   * propagates out of `createProvider`, gets caught by `registry.add`,
   * and the listener is logged-and-skipped instead of taking down every
   * other listener in the pod.
   *
   * On success we immediately `eth_unsubscribe` so the upcoming
   * `provider.on("block", ...)` opens a fresh subscription that ethers
   * actually routes messages through. An unsubscribe failure is
   * non-fatal: the orphaned subscription is cleaned up when the provider
   * is destroyed (next reconnect or shutdown).
   */
  private async probeSubscriptionSupport(
    provider: ethers.WebSocketProvider,
    entry: ChainEntry,
    urlUsed: string,
  ): Promise<void> {
    let filterId: unknown;
    try {
      // Race the RPC call against an explicit timeout. ethers does not
      // give us an externally controllable timeout on `provider.send`,
      // and an upstream that accepts the WS handshake but never answers
      // the JSON-RPC frame would otherwise hang createProvider for the
      // life of the socket. The Node 20 native timer doesn't need clearing
      // because the race winner discards the loser's result, but we still
      // clear it explicitly so the timeout doesn't keep the event loop
      // alive after a fast probe.
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(
                `eth_subscribe probe timed out after ${PROBE_TIMEOUT_MS}ms`,
              ),
            ),
          PROBE_TIMEOUT_MS,
        );
      });
      try {
        filterId = await Promise.race([
          provider.send("eth_subscribe", ["newHeads"]),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `chain ${entry.chainId} (${urlUsed}): RPC does not support eth_subscribe: ${message}`,
      );
    }
    try {
      await provider.send("eth_unsubscribe", [filterId]);
    } catch (err) {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} probe eth_unsubscribe failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private attachBlockListener(entry: ChainEntry): void {
    if (!entry.provider) {
      throw new Error(
        `attachBlockListener: provider not initialized for chain ${entry.chainId}`,
      );
    }
    const listener = async (blockNumber: number): Promise<void> => {
      const now = Date.now();
      this.recordBlockInterval(entry, now);
      entry.lastBlockAt = now;
      if (!this.isBatching(entry)) {
        await this.processBlockRange(entry, blockNumber, blockNumber);
        return;
      }
      await this.bufferBlock(entry, blockNumber);
    };
    entry.blockListener = listener;
    // Baseline for the block-staleness watchdog: until the first block
    // arrives, staleness is measured from attach time so a subscription that
    // never delivers a block is still caught.
    entry.blockListenerAttachedAt = Date.now();
    // A fresh connection re-learns the chain's cadence. Carrying the previous
    // connection's estimate across a reconnect would let a stale value decide
    // batching for a provider that may be a different upstream entirely.
    entry.lastBlockIntervalAt = null;
    entry.blockIntervalEwmaMs = null;
    entry.blockIntervalSamples = 0;
    entry.provider.on("block", listener);
    this.startStatsTimer();
  }

  /**
   * Stop delivering blocks on this connection.
   *
   * `retainWindow` decides the fate of an open coalescing window, and the two
   * cases are not alike. Unsubscribe and destroy leave no subscriber to
   * dispatch to, so the buffered numbers are discarded. A reconnect does not:
   * its subscribers are still attached and still expect those logs, and
   * discarding them would lose events that per-block dispatch never could.
   * The numbers are just block heights, not provider state, so the reconnect
   * carries them and the replacement connection serves them.
   */
  private detachBlockListener(entry: ChainEntry, retainWindow = false): void {
    entry.blockListenerAttachedAt = null;
    // The timer always goes: it must not fire against a provider that is
    // being torn down.
    this.stopBatchTimer(entry);
    if (!retainWindow) {
      entry.pendingBlocks = [];
    }
    if (!(entry.provider && entry.blockListener)) {
      entry.blockListener = null;
      return;
    }
    entry.provider.off("block", entry.blockListener);
    entry.blockListener = null;
  }

  /**
   * Fold this block's arrival into the chain's inter-block interval estimate.
   * The first block after an attach establishes the baseline only - there is
   * no prior arrival on this connection to measure against.
   */
  private recordBlockInterval(entry: ChainEntry, now: number): void {
    const previous = entry.lastBlockIntervalAt;
    entry.lastBlockIntervalAt = now;
    if (previous === null) {
      return;
    }
    const interval = now - previous;
    // A duplicate or out-of-order push can report a non-positive gap; it
    // carries no cadence information, so it is not a sample.
    if (interval <= 0) {
      return;
    }
    entry.blockIntervalEwmaMs =
      entry.blockIntervalEwmaMs === null
        ? interval
        : BLOCK_INTERVAL_EWMA_ALPHA * interval +
          (1 - BLOCK_INTERVAL_EWMA_ALPHA) * entry.blockIntervalEwmaMs;
    entry.blockIntervalSamples += 1;
  }

  /**
   * Whether this chain has proven itself fast enough to coalesce blocks.
   * False until the estimate is warm, so a chain always starts out dispatching
   * per block and only changes behaviour once its cadence is established.
   */
  private isBatching(entry: ChainEntry): boolean {
    return (
      entry.blockIntervalSamples >= BLOCK_INTERVAL_WARMUP_SAMPLES &&
      entry.blockIntervalEwmaMs !== null &&
      entry.blockIntervalEwmaMs < BATCHING_BLOCK_INTERVAL_THRESHOLD_MS
    );
  }

  /**
   * Add a block to the open window, opening one if needed. The window is
   * measured from its first block, so it bounds the delay any single block
   * waits rather than sliding forward as blocks keep arriving.
   */
  private async bufferBlock(
    entry: ChainEntry,
    blockNumber: number,
  ): Promise<void> {
    entry.pendingBlocks.push(blockNumber);
    if (entry.pendingBlocks.length >= BATCH_MAX_BLOCKS) {
      await this.flushBatchWindow(entry);
      return;
    }
    if (!entry.batchTimer) {
      entry.batchTimer = setTimeout(() => {
        void this.flushBatchWindow(entry);
      }, BATCH_WINDOW_MS);
    }
  }

  /**
   * Issue one ranged `eth_getLogs` covering every block buffered in the open
   * window, then close it.
   */
  private async flushBatchWindow(entry: ChainEntry): Promise<void> {
    const blocks = entry.pendingBlocks;
    this.stopBatchTimer(entry);
    entry.pendingBlocks = [];
    if (blocks.length === 0) {
      return;
    }
    // Span the extremes rather than the arrival order. A ranged request also
    // covers any block the subscription skipped inside the window, which
    // recovers logs a per-block loop would have missed; the dedup layer
    // absorbs anything that arrives twice as a result.
    await this.processBlockRange(
      entry,
      Math.min(...blocks),
      Math.max(...blocks),
    );
  }

  private stopBatchTimer(entry: ChainEntry): void {
    if (entry.batchTimer) {
      clearTimeout(entry.batchTimer);
      entry.batchTimer = null;
    }
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
      return;
    }

    // The heartbeat succeeded, so the RPC is answering. That does not prove
    // the newHeads subscription is still delivering blocks - a silently
    // dropped subscription passes the heartbeat forever. Block-staleness is
    // the only signal that catches it.
    this.checkBlockStaleness(entry);
  }

  /**
   * Block-staleness threshold for one chain.
   *
   * The fixed default is slack measured in wall-clock, not in blocks: 120 s is
   * ten blocks on Ethereum but 1.2 million on a 100 ms chain, where a dead
   * subscription would go unnoticed far longer in the terms that matter. Only
   * a chain fast enough to be batching derives its own threshold, so every
   * chain dispatching per block keeps the historical value exactly and this
   * cannot introduce reconnect churn on a chain that behaves today.
   */
  private stalenessTimeoutFor(entry: ChainEntry): number {
    if (this.blockStalenessTimeoutOverrideMs !== null) {
      return this.blockStalenessTimeoutOverrideMs;
    }
    const ewma = entry.blockIntervalEwmaMs;
    if (!this.isBatching(entry) || ewma === null) {
      return BLOCK_STALENESS_TIMEOUT_MS;
    }
    return Math.max(
      BLOCK_STALENESS_FLOOR_MS,
      ewma * BLOCK_STALENESS_BLOCK_MULTIPLIER,
    );
  }

  /**
   * Reconnect a chain whose connection is answering the heartbeat but has
   * stopped delivering blocks past its staleness threshold. Runs on each
   * heartbeat tick (after a successful ping) so it inherits the heartbeat's
   * subscriber-scoped lifecycle. Measures staleness from the last delivered
   * block, or - before any block has arrived - from when the block listener
   * attached, so a subscription that never delivers is also caught.
   */
  private checkBlockStaleness(entry: ChainEntry): void {
    if (this.isDestroyed || entry.isReconnecting || !entry.provider) {
      return;
    }
    // Blocks are only expected while a subscriber (and thus a block
    // listener) is attached; an idle provider is legitimately silent.
    if (entry.subscribers.size === 0) {
      return;
    }
    // Measure from the most recent of the last delivered block and the
    // current block-listener attach time. After a reconnect, lastBlockAt
    // still holds the pre-drop timestamp, so folding in the fresh attach
    // time gives the new connection a full window to deliver its first
    // block instead of tripping again immediately. Real timestamps are
    // always > 0, so 0 means neither is set.
    const reference = Math.max(
      entry.lastBlockAt ?? 0,
      entry.blockListenerAttachedAt ?? 0,
    );
    if (reference === 0) {
      return;
    }
    const age = Date.now() - reference;
    const timeout = this.stalenessTimeoutFor(entry);
    if (age <= timeout) {
      return;
    }
    logger.warn(
      `[ChainProviderManager] chain=${entry.chainId} no block for ${age}ms while heartbeat passing; treating subscription as dead and reconnecting`,
    );
    this.triggerReconnect(
      entry,
      "block_staleness",
      `no block received for ${age}ms while heartbeat passing`,
    );
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
    // Disarm the coalescing window here rather than in `reconnect()`, which
    // does not run until the backoff has elapsed. The window is the same
    // width as the initial backoff, so leaving it armed lets it fire against
    // the connection that just failed: the request throws, and the buffered
    // blocks are lost to a logged warning. The blocks themselves are kept -
    // `reconnect()` carries them to the replacement.
    this.stopBatchTimer(entry);

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
          // Surface the most recent attempt error through /healthz so an
          // operator can see *why* the chain is stuck reconnecting, not
          // just that it is. Cleared on the next successful reconnect.
          entry.lastCreateError =
            err instanceof Error ? err.message : String(err);
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
      this.detachBlockListener(entry, true);
      this.detachErrorListener(entry);
      try {
        await entry.provider.destroy();
      } catch {
        // ignore
      }
    }
    entry.provider = null;
    entry.activeWssUrl = null;
    entry.readyPromise = null;

    if (this.isDestroyed) {
      return;
    }

    // Re-create using the same primary-then-fallback walk as
    // createProvider. Each (re)connect tries primary first so a primary
    // that recovers is preferred. Any throw here propagates to the loop
    // which handles backoff.
    const { provider, urlUsed } = await this.openProvider(entry);

    // Destroy may have run while we were waiting for `ready` / probe. If
    // so, the entry we are about to populate is no longer in
    // `this.chains` and attaching listeners would leak a provider that
    // never gets destroyed by the second pass.
    if (this.isDestroyed) {
      try {
        await provider.destroy();
      } catch {
        // ignore
      }
      return;
    }

    entry.provider = provider;
    entry.activeWssUrl = urlUsed;
    if (urlUsed !== entry.wssUrl) {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} reconnected on fallback ${urlUsed}`,
      );
    }
    // Successful reconnect clears any prior failure marker so /healthz
    // stops reporting a stale error on a now-healthy chain.
    entry.lastCreateError = null;

    this.attachErrorListener(entry);
    // Block listener and heartbeat only if this chain has subscribers.
    // Both are subscriber-scoped; if every subscriber unsubscribed
    // during the reconnect, the new provider stays quiet until someone
    // subscribes again.
    if (entry.subscribers.size > 0) {
      this.attachBlockListener(entry);
      this.startHeartbeat(entry);
      // Serve the window the dropped connection was holding. These heights
      // are historical by now, so the replacement answers for them as well as
      // the original would have.
      await this.flushBatchWindow(entry);
    }
  }

  /**
   * Fetch and dispatch the logs in `[fromBlock, toBlock]`. The two are equal
   * on a per-block dispatch and span the window on a batched one, so both
   * paths issue the same shape of request.
   */
  private async processBlockRange(
    entry: ChainEntry,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    const subscribers = [...entry.subscribers];
    if (subscribers.length === 0 || !entry.provider) {
      return;
    }

    const { addresses, topic0s } = this.collectFilter(subscribers);
    const fromHex = `0x${fromBlock.toString(16)}`;
    const toHex = `0x${toBlock.toString(16)}`;
    entry.stats.ranges += 1;
    entry.stats.blocksCovered += toBlock - fromBlock + 1;

    try {
      const logs: ethers.Log[] = [];
      for (let i = 0; i < addresses.length; i += GETLOGS_ADDRESS_BATCH) {
        const chunk = addresses.slice(i, i + GETLOGS_ADDRESS_BATCH);
        // Counted at the call rather than the range: one range over more
        // than GETLOGS_ADDRESS_BATCH addresses is still several requests,
        // and requests are the quantity the provider bills.
        entry.stats.getLogsCalls += 1;
        entry.stats.getLogsCallsTotal += 1;
        const batch = (await entry.provider.send("eth_getLogs", [
          {
            fromBlock: fromHex,
            toBlock: toHex,
            address: chunk,
            topics: [topic0s],
          },
        ])) as ethers.Log[];
        logs.push(...batch);
      }

      for (const log of logs) {
        await this.dispatchLog(entry, log);
      }
      entry.stats.logsDispatched += logs.length;
    } catch (err) {
      entry.stats.getLogsErrors += 1;
      const range =
        fromBlock === toBlock
          ? `block=${fromBlock}`
          : `blocks=${fromBlock}-${toBlock}`;
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} ${range} getLogs failed: ${String(err)}`,
      );
    }
  }

  private startStatsTimer(): void {
    if (this.statsTimer || this.isDestroyed) {
      return;
    }
    const timer = setInterval(() => {
      this.logStats();
    }, STATS_LOG_INTERVAL_MS);
    timer.unref?.();
    this.statsTimer = timer;
  }

  private stopStatsTimer(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /**
   * Emit one line per chain that issued a request this interval, then reset
   * the per-interval counters. Chains that did nothing stay silent so an idle
   * tracker does not emit a line per chain per minute forever.
   */
  private logStats(): void {
    for (const entry of this.chains.values()) {
      const stats = entry.stats;
      if (stats.getLogsCalls === 0 && stats.getLogsErrors === 0) {
        continue;
      }
      const interval =
        entry.blockIntervalEwmaMs === null
          ? "null"
          : String(Math.round(entry.blockIntervalEwmaMs));
      logger.log(
        `[ChainProviderManager] getlogs-stats chain=${entry.chainId} batching=${this.isBatching(entry)} blockIntervalMs=${interval} windowMs=${BATCH_WINDOW_MS} intervalMs=${STATS_LOG_INTERVAL_MS} getLogsCalls=${stats.getLogsCalls} getLogsErrors=${stats.getLogsErrors} blocksCovered=${stats.blocksCovered} ranges=${stats.ranges} logsDispatched=${stats.logsDispatched} getLogsCallsTotal=${stats.getLogsCallsTotal}`,
      );
      stats.getLogsCalls = 0;
      stats.getLogsErrors = 0;
      stats.blocksCovered = 0;
      stats.ranges = 0;
      stats.logsDispatched = 0;
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
