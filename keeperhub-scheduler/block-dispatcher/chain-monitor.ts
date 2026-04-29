/**
 * Chain Monitor
 *
 * Monitors a single blockchain chain via ethers.js WebSocketProvider.
 * When a block matches a workflow's interval, enqueues a trigger to SQS.
 *
 * ethers v6 WebSocketProvider uses eth_subscribe ("newHeads") over the
 * WebSocket to receive block notifications (SocketBlockSubscriber, not
 * polling). A WebSocket-level ping/pong runs every 30s to verify the
 * connection is alive, and a no-block timeout forces reconnection if the
 * provider goes silent.
 */

import { ethers } from "ethers";
import { enqueueBlockTrigger } from "./sqs-enqueue.js";
import type { BlockWorkflow, ChainConfig } from "../lib/types.js";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;
const NO_BLOCK_TIMEOUT_MS = 5 * 60_000; // 5 minutes
const STALE_BLOCK_THRESHOLD_S = 120; // warn if block timestamp >2 min behind
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_BACKFILL_BLOCKS = 100;
const PRIMARY_PROBE_TIMEOUT_MS = 5_000;
// Overridable via env so dev/tests don't wait 5 minutes. Read on each
// startPrimaryProbe() call so the override applies even when set after
// module load (e.g. inside a test setup).
function getPrimaryProbeIntervalMs(): number {
  return Number(process.env.PRIMARY_PROBE_INTERVAL_MS) || 5 * 60_000;
}

type ChainMonitorConfig = {
  chain: ChainConfig;
  workflows: BlockWorkflow[];
};

// Reduces a probe-failure error to a single short tag like "HTTP 429",
// "timeout", or a 60-char first-line slice. Keeps log lines compact —
// ethers errors can include long JSON-RPC payloads and ABI dumps otherwise.
function summarizeProbeError(error: unknown): string {
  const fullMessage = error instanceof Error ? error.message : String(error);
  const httpMatch = fullMessage.match(/Unexpected server response: (\d{3})/);
  if (httpMatch) {
    return `HTTP ${httpMatch[1]}`;
  }
  if (fullMessage.toLowerCase().includes("timeout")) {
    return "timeout";
  }
  return fullMessage.split("\n")[0].slice(0, 60);
}

export class ChainMonitor {
  private readonly chainId: number;
  private readonly chainName: string;
  private provider: ethers.WebSocketProvider | null = null;
  private workflows: BlockWorkflow[];
  private readonly primaryWss: string | null;
  private readonly fallbackWss: string | null;
  private isRunning = false;
  private isReconnecting = false;
  private isProcessing = false;
  private pendingBlock: number | null = null;
  private reconnectAttempts = 0;
  private lastProcessedBlock: number | null = null;
  private blocksReceived = 0;
  private blocksMatched = 0;
  private lastHeartbeat = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private noBlockTimer: ReturnType<typeof setTimeout> | null = null;
  private primaryProbeTimer: ReturnType<typeof setInterval> | null = null;
  private currentUrlIndex = 0;
  private hasActiveSubscription = false;
  private wsCloseHandler: (() => void) | null = null;

  constructor(config: ChainMonitorConfig) {
    this.chainId = config.chain.chainId;
    this.chainName = config.chain.name;
    this.primaryWss = config.chain.defaultPrimaryWss;
    this.fallbackWss = config.chain.defaultFallbackWss;
    this.workflows = config.workflows;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      await this.connect();
      await this.subscribeToBlocks();
      this.startPingPong();
      this.resetNoBlockTimer();
      this.startPrimaryProbe();
    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.isReconnecting = false;
    this.stopTimers();
    await this.destroyProvider();
  }

  updateWorkflows(workflows: BlockWorkflow[]): void {
    this.workflows = workflows;
  }

  hasConfigChanged(chain: ChainConfig): boolean {
    return (
      this.primaryWss !== chain.defaultPrimaryWss ||
      this.fallbackWss !== chain.defaultFallbackWss
    );
  }

  getChainId(): number {
    return this.chainId;
  }

  isAlive(): boolean {
    return this.isRunning && (this.hasActiveSubscription || this.isReconnecting);
  }

  getStatus(): {
    chainId: number;
    chainName: string;
    alive: boolean;
    reconnecting: boolean;
    hasSubscription: boolean;
    lastBlock: number | null;
    blocksReceived: number;
    blocksMatched: number;
    workflows: number;
  } {
    return {
      chainId: this.chainId,
      chainName: this.chainName,
      alive: this.isAlive(),
      reconnecting: this.isReconnecting,
      hasSubscription: this.hasActiveSubscription,
      lastBlock: this.lastProcessedBlock,
      blocksReceived: this.blocksReceived,
      blocksMatched: this.blocksMatched,
      workflows: this.workflows.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Provider lifecycle
  // ---------------------------------------------------------------------------

  private async destroyProvider(): Promise<void> {
    this.hasActiveSubscription = false;

    if (this.provider) {
      // Remove the raw WebSocket close handler before destroying to prevent
      // stale handlers from firing handleDisconnect during teardown
      if (this.wsCloseHandler) {
        const ws = this.provider.websocket as unknown as {
          removeListener?: (event: string, cb: () => void) => void;
        };
        ws?.removeListener?.("close", this.wsCloseHandler);
        this.wsCloseHandler = null;
      }

      await this.provider.removeAllListeners();
      try {
        await this.provider.destroy();
      } catch {
        // ignore cleanup errors
      }
      this.provider = null;
    }
  }

  private async connect(): Promise<void> {
    const urls = [this.primaryWss, this.fallbackWss].filter(
      (url): url is string => url !== null && url !== ""
    );

    if (urls.length === 0) {
      throw new Error(
        `No WSS URLs configured for chain ${this.chainName} (${this.chainId})`
      );
    }

    for (const [index, url] of urls.entries()) {
      const label = index === 0 ? "primary" : "fallback";
      let provider: ethers.WebSocketProvider | null = null;
      try {
        provider = new ethers.WebSocketProvider(url);

        // ethers v6 WebSocketProvider does not attach an 'error' listener on
        // the underlying ws. Without one, an HTTP 429 (or any non-101 upgrade
        // response) makes ws emit 'error' on the socket which Node escalates
        // to uncaughtException, killing the entire dispatcher process.
        //
        // Attach our own listener so the error is consumed and surfaces as a
        // normal rejection of the connect race below, allowing the fallback
        // URL loop and reconnect-with-backoff to do their job.
        const wsErrorPromise = this.attachConnectErrorListener(provider);

        // NOTE: provider.ready is a synchronous boolean getter
        // (`get ready() { return this.#notReady == null; }`), NOT a Promise.
        // Awaiting it resolves immediately and tells us nothing about the ws.
        // To actually confirm the upgrade succeeded we issue a real network
        // call which internally waits for the underlying ws to be open via
        // `_waitUntilReady()`.
        const blockNumber = (await Promise.race([
          provider.getBlockNumber(),
          wsErrorPromise,
          new Promise<number>((_, reject) => {
            setTimeout(
              () => reject(new Error("Connection timeout")),
              CONNECT_TIMEOUT_MS
            );
          }),
        ])) as number;

        this.provider = provider;
        this.currentUrlIndex = index;
        console.log(
          `[BlockMonitor:${this.chainName}] Connected to ${label} WSS (block: ${blockNumber})`
        );
        return;
      } catch (error) {
        // Destroy the provider if it was created but failed/timed out
        if (provider) {
          await provider.removeAllListeners();
          await provider.destroy().catch(() => {});
        }
        console.warn(
          `[BlockMonitor:${this.chainName}] Failed to connect to ${label} WSS:`,
          error instanceof Error ? error.message : error
        );
        if (index === urls.length - 1) {
          throw error;
        }
      }
    }

    throw new Error("Unreachable");
  }

  private attachConnectErrorListener(
    provider: ethers.WebSocketProvider
  ): Promise<never> {
    const ws = provider.websocket as unknown as {
      on?: (event: string, cb: (err: Error) => void) => void;
    };

    return new Promise<never>((_, reject) => {
      ws?.on?.("error", (err: Error) => {
        const message = err?.message ?? String(err);
        console.warn(
          `[BlockMonitor:${this.chainName}] WebSocket error during connect: ${message}`
        );
        reject(new Error(`WebSocket error: ${message}`));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Block subscription
  // ---------------------------------------------------------------------------

  private async subscribeToBlocks(): Promise<void> {
    if (!this.provider) {
      return;
    }

    console.log(
      `[BlockMonitor:${this.chainName}] Subscribing to block events`
    );

    // ethers v6 provider.on() is async - it sends eth_subscribe over the
    // WebSocket and waits for the subscription ID. Must be awaited or the
    // subscription silently fails on reconnection.
    await this.provider.on("block", (blockNumber: number) => {
      this.onBlock(blockNumber).catch((error: unknown) => {
        console.error(
          `[BlockMonitor:${this.chainName}] Error processing block ${blockNumber}:`,
          error instanceof Error ? error.message : error
        );
      });
    });

    this.hasActiveSubscription = true;
    console.log(
      `[BlockMonitor:${this.chainName}] Block subscription active`
    );

    // Handle WebSocket close for reconnection - store reference for cleanup
    const ws = this.provider.websocket as unknown as {
      on?: (event: string, cb: () => void) => void;
    };
    if (ws?.on) {
      this.wsCloseHandler = () => {
        console.warn(`[BlockMonitor:${this.chainName}] WebSocket closed`);
        this.hasActiveSubscription = false;
        this.handleDisconnect();
      };
      ws.on("close", this.wsCloseHandler);
    }
  }

  // ---------------------------------------------------------------------------
  // Block processing
  // ---------------------------------------------------------------------------

  private async onBlock(blockNumber: number): Promise<void> {
    this.resetNoBlockTimer();

    // Deduplicate — ethers may fire the same block from both polling and newHeads
    if (
      this.lastProcessedBlock !== null &&
      blockNumber <= this.lastProcessedBlock
    ) {
      return;
    }

    // Serialize processing — if already handling a block, queue the latest and return
    if (this.isProcessing) {
      this.pendingBlock = blockNumber;
      return;
    }

    this.isProcessing = true;
    try {
      await this.processBlockRange(blockNumber);
    } finally {
      this.isProcessing = false;
    }

    // Drain any block that arrived while we were processing
    while (this.pendingBlock !== null) {
      const next = this.pendingBlock;
      this.pendingBlock = null;

      if (
        this.lastProcessedBlock !== null &&
        next <= this.lastProcessedBlock
      ) {
        continue;
      }

      this.isProcessing = true;
      try {
        await this.processBlockRange(next);
      } finally {
        this.isProcessing = false;
      }
    }
  }

  private async processBlockRange(blockNumber: number): Promise<void> {
    if (this.lastProcessedBlock === null) {
      console.log(
        `[BlockMonitor:${this.chainName}] First block received: ${blockNumber}, tracking ${this.workflows.length} workflow(s): ${this.workflows.map((wf) => `${wf.id}(interval=${wf.blockInterval})`).join(", ")}`
      );
    }

    const fromBlock =
      this.lastProcessedBlock !== null
        ? this.lastProcessedBlock + 1
        : blockNumber;

    const gap = blockNumber - fromBlock;

    if (gap > MAX_BACKFILL_BLOCKS) {
      console.warn(
        `[BlockMonitor:${this.chainName}] Gap too large (${gap} blocks), skipping backfill. Resuming from block ${blockNumber}`
      );
    } else if (fromBlock < blockNumber) {
      console.log(
        `[BlockMonitor:${this.chainName}] Gap detected: last=${this.lastProcessedBlock}, received=${blockNumber}, backfilling ${gap} block(s)`
      );

      for (let bn = fromBlock; bn < blockNumber; bn++) {
        await this.processBlockNumber(bn);
      }
    }

    await this.processBlockNumber(blockNumber);
    this.lastProcessedBlock = blockNumber;
    this.blocksReceived++;

    // Heartbeat log
    const now = Date.now();
    if (now - this.lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      console.log(
        `[BlockMonitor:${this.chainName}] Heartbeat: block=${blockNumber}, received=${this.blocksReceived}, matched=${this.blocksMatched}, workflows=${this.workflows.length}`
      );
      this.lastHeartbeat = now;
    }
  }

  private async processBlockNumber(blockNumber: number): Promise<void> {
    const matchingWorkflows = this.workflows.filter(
      (wf) => blockNumber > 0 && blockNumber % wf.blockInterval === 0
    );

    if (matchingWorkflows.length === 0) {
      return;
    }

    // Fetch block data for the matched block
    const block = await this.getBlockData(blockNumber);
    if (!block) {
      return;
    }

    // Stale block warning
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - block.timestamp > STALE_BLOCK_THRESHOLD_S) {
      console.warn(
        `[BlockMonitor:${this.chainName}] Block ${blockNumber} timestamp is ${nowSeconds - block.timestamp}s behind wall clock`
      );
    }

    this.blocksMatched++;
    console.log(
      `[BlockMonitor:${this.chainName}] Block ${blockNumber} matched ${matchingWorkflows.length} workflow(s): ${matchingWorkflows.map((wf) => `${wf.id}(interval=${wf.blockInterval})`).join(", ")}`
    );

    const results = await Promise.allSettled(
      matchingWorkflows.map((wf) =>
        enqueueBlockTrigger({
          workflowId: wf.id,
          userId: wf.userId,
          triggerType: "block",
          triggerData: {
            blockNumber,
            blockHash: block.hash,
            blockTimestamp: block.timestamp,
            parentHash: block.parentHash,
          },
        })
      )
    );

    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        console.error(
          `[BlockMonitor:${this.chainName}] Failed to enqueue workflow ${matchingWorkflows[index].id}:`,
          result.reason
        );
      }
    }
  }

  private async getBlockData(blockNumber: number): Promise<{
    hash: string;
    timestamp: number;
    parentHash: string;
  } | null> {
    if (!this.provider) {
      return null;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const block = await this.provider.getBlock(blockNumber);
        if (block) {
          return {
            hash: block.hash ?? "",
            timestamp: block.timestamp,
            parentHash: block.parentHash,
          };
        }
      } catch (error) {
        if (attempt === 1) {
          console.warn(
            `[BlockMonitor:${this.chainName}] Failed to fetch block ${blockNumber} after 2 attempts:`,
            error instanceof Error ? error.message : error
          );
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // WebSocket ping/pong & no-block timeout
  // ---------------------------------------------------------------------------

  private startPingPong(): void {
    this.stopPingPong();

    const ws = this.provider?.websocket as unknown as {
      ping?: (data?: unknown) => void;
      on?: (event: string, cb: () => void) => void;
      readyState?: number;
    };

    if (!ws?.ping || !ws?.on) {
      console.warn(
        `[BlockMonitor:${this.chainName}] WebSocket does not support ping/pong, skipping keepalive`
      );
      return;
    }

    // Listen for pong responses — clears the timeout each time
    ws.on("pong", () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });

    this.pingTimer = setInterval(() => {
      if (!this.isRunning || ws.readyState !== 1) {
        return;
      }

      try {
        ws.ping!();
      } catch {
        console.warn(
          `[BlockMonitor:${this.chainName}] Failed to send ping, triggering reconnect`
        );
        this.handleDisconnect();
        return;
      }

      // If no pong arrives within timeout, connection is dead
      this.pongTimer = setTimeout(() => {
        console.warn(
          `[BlockMonitor:${this.chainName}] Pong timeout (${PONG_TIMEOUT_MS}ms), triggering reconnect`
        );
        this.handleDisconnect();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    console.log(
      `[BlockMonitor:${this.chainName}] Ping/pong keepalive started (interval=${PING_INTERVAL_MS}ms, timeout=${PONG_TIMEOUT_MS}ms)`
    );
  }

  private stopPingPong(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private resetNoBlockTimer(): void {
    this.stopNoBlockTimer();
    this.noBlockTimer = setTimeout(() => {
      if (this.isRunning) {
        console.warn(
          `[BlockMonitor:${this.chainName}] No blocks received in ${NO_BLOCK_TIMEOUT_MS / 1000}s, triggering reconnect`
        );
        this.handleDisconnect();
      }
    }, NO_BLOCK_TIMEOUT_MS);
  }

  private stopNoBlockTimer(): void {
    if (this.noBlockTimer) {
      clearTimeout(this.noBlockTimer);
      this.noBlockTimer = null;
    }
  }

  private stopTimers(): void {
    this.stopPingPong();
    this.stopNoBlockTimer();
    this.stopPrimaryProbe();
  }

  // ---------------------------------------------------------------------------
  // Primary recovery probe
  //
  // When we are running on the fallback URL, periodically test the primary in a
  // throwaway provider. If it answers a getBlockNumber within the timeout, we
  // close the current (fallback) connection and let reconnectWithBackoff swap
  // back to primary. The fallback is kept active until the moment we trigger
  // the swap, so monitoring is never interrupted.
  // ---------------------------------------------------------------------------

  private startPrimaryProbe(): void {
    this.stopPrimaryProbe();

    if (this.currentUrlIndex === 0 || !this.primaryWss) {
      return;
    }

    this.primaryProbeTimer = setInterval(() => {
      this.probePrimary().catch(() => {
        // probePrimary handles its own logging; nothing to do here
      });
    }, getPrimaryProbeIntervalMs());
  }

  private stopPrimaryProbe(): void {
    if (this.primaryProbeTimer) {
      clearInterval(this.primaryProbeTimer);
      this.primaryProbeTimer = null;
    }
  }

  private async probePrimary(): Promise<void> {
    if (!(this.isRunning && this.primaryWss) || this.currentUrlIndex === 0) {
      this.stopPrimaryProbe();
      return;
    }

    let probeProvider: ethers.WebSocketProvider | null = null;
    try {
      probeProvider = new ethers.WebSocketProvider(this.primaryWss);
      // Inline silent listener (not attachConnectErrorListener) so probe
      // failures produce only the single "Primary probe failed" line below.
      const ws = probeProvider.websocket as unknown as {
        on?: (event: string, cb: (err: Error) => void) => void;
      };
      const wsErrorPromise = new Promise<never>((_, reject) => {
        ws?.on?.("error", (err: Error) => {
          reject(new Error(err?.message ?? String(err)));
        });
      });

      await Promise.race([
        probeProvider.getBlockNumber(),
        wsErrorPromise,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Primary probe timeout")),
            PRIMARY_PROBE_TIMEOUT_MS
          );
        }),
      ]);

      console.log(
        `[BlockMonitor:${this.chainName}] Primary recovered, switching back from fallback`
      );
      await probeProvider.removeAllListeners();
      await probeProvider.destroy().catch(() => {
        // ignore cleanup errors
      });
      this.handleDisconnect();
    } catch (error) {
      const reason = summarizeProbeError(error);
      console.warn(
        `[BlockMonitor:${this.chainName}] Primary probe failed: ${reason}`
      );
      if (probeProvider) {
        await probeProvider.removeAllListeners();
        await probeProvider.destroy().catch(() => {
          // ignore cleanup errors
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnection (max attempts with exponential backoff)
  // ---------------------------------------------------------------------------

  private handleDisconnect(): void {
    if (!this.isRunning || this.isReconnecting) {
      return;
    }

    this.isReconnecting = true;
    this.stopTimers();

    this.reconnectWithBackoff().catch((error: unknown) => {
      console.error(
        `[BlockMonitor:${this.chainName}] Reconnect loop failed:`,
        error instanceof Error ? error.message : error
      );
      this.isReconnecting = false;
    });
  }

  private async reconnectWithBackoff(): Promise<void> {
    await this.destroyProvider();

    while (this.isRunning) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(
          `[BlockMonitor:${this.chainName}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, stopping monitor`
        );
        this.isRunning = false;
        this.isReconnecting = false;
        return;
      }

      this.reconnectAttempts++;
      const delay = Math.min(
        BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
        MAX_DELAY_MS
      );

      console.log(
        `[BlockMonitor:${this.chainName}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });

      if (!this.isRunning) {
        return;
      }

      try {
        await this.connect();
        await this.subscribeToBlocks();
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.startPingPong();
        this.resetNoBlockTimer();
        this.startPrimaryProbe();
        return;
      } catch (error) {
        console.warn(
          `[BlockMonitor:${this.chainName}] Reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} failed:`,
          error instanceof Error ? error.message : error
        );
        // Clean up the provider if connect succeeded but subscribe failed
        await this.destroyProvider();
      }
    }
  }
}
