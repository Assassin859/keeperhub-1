/**
 * Chain Monitor
 *
 * Monitors a single blockchain chain via ethers.js WebSocketProvider.
 * When a block matches a workflow's interval, enqueues a trigger to SQS.
 *
 * ethers.js polls eth_blockNumber internally (~4s) in addition to receiving
 * newHeads notifications, so it detects new blocks even when the RPC provider
 * fails to push subscription events. A WebSocket-level ping/pong runs every
 * 30s to verify the connection is alive, and a no-block timeout forces
 * reconnection if the provider goes silent.
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

type ChainMonitorConfig = {
  chain: ChainConfig;
  workflows: BlockWorkflow[];
};

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
      await this.validateConnection();
      this.subscribeToBlocks();
      this.startPingPong();
      this.resetNoBlockTimer();
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
    return this.isRunning;
  }

  // ---------------------------------------------------------------------------
  // Provider lifecycle
  // ---------------------------------------------------------------------------

  private async destroyProvider(): Promise<void> {
    if (this.provider) {
      this.provider.removeAllListeners();
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

        await Promise.race([
          provider.ready,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Connection timeout")),
              CONNECT_TIMEOUT_MS
            )
          ),
        ]);

        this.provider = provider;
        console.log(
          `[BlockMonitor:${this.chainName}] Connected to ${label} WSS`
        );
        return;
      } catch (error) {
        // Destroy the provider if it was created but failed/timed out
        if (provider) {
          provider.removeAllListeners();
          provider.destroy().catch(() => {});
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

  private async validateConnection(): Promise<void> {
    if (!this.provider) {
      return;
    }

    try {
      const blockNumber = await this.provider.getBlockNumber();
      console.log(
        `[BlockMonitor:${this.chainName}] Provider reports block: ${blockNumber}`
      );
    } catch (error) {
      console.warn(
        `[BlockMonitor:${this.chainName}] Failed to validate connection:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Block subscription
  // ---------------------------------------------------------------------------

  private subscribeToBlocks(): void {
    if (!this.provider) {
      return;
    }

    console.log(
      `[BlockMonitor:${this.chainName}] Subscribing to block events`
    );

    this.provider.on("block", (blockNumber: number) => {
      this.onBlock(blockNumber).catch((error: unknown) => {
        console.error(
          `[BlockMonitor:${this.chainName}] Error processing block ${blockNumber}:`,
          error instanceof Error ? error.message : error
        );
      });
    });

    // Handle WebSocket close for reconnection
    const ws = this.provider.websocket as unknown as {
      on?: (event: string, cb: () => void) => void;
    };
    if (ws?.on) {
      ws.on("close", () => {
        console.warn(`[BlockMonitor:${this.chainName}] WebSocket closed`);
        this.handleDisconnect();
      });
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
        await this.validateConnection();
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.subscribeToBlocks();
        this.startPingPong();
        this.resetNoBlockTimer();
        return;
      } catch (error) {
        console.warn(
          `[BlockMonitor:${this.chainName}] Reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} failed:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }
}
