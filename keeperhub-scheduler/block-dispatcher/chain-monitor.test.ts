import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainMonitor } from "./chain-monitor.js";
import type { BlockWorkflow, ChainConfig } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Mock SQS enqueue - prevent real AWS calls
// ---------------------------------------------------------------------------

vi.mock("./sqs-enqueue.js", () => ({
  enqueueBlockTrigger: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock WebSocket that supports ping/pong and close events
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  readyState = 1;
  ping(): void {
    setTimeout(() => this.emit("pong"), 0);
  }
  removeListener(event: string, cb: () => void): this {
    return super.removeListener(event, cb);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  send(): void {}
}

// ---------------------------------------------------------------------------
// Mock ethers.WebSocketProvider
// ---------------------------------------------------------------------------

type BlockListener = (blockNumber: number) => void;

class MockProvider {
  readonly websocket: MockWebSocket;
  destroyed = false;
  private blockListeners: BlockListener[] = [];

  ready: Promise<unknown>;

  constructor(readonly url: string) {
    this.websocket = new MockWebSocket();
    this.ready = Promise.resolve(true);
  }

  async getBlockNumber(): Promise<number> {
    return 100;
  }

  async getBlock(
    blockNumber: number
  ): Promise<{
    hash: string;
    timestamp: number;
    parentHash: string;
  }> {
    return {
      hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      timestamp: Math.floor(Date.now() / 1000),
      parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "0")}`,
    };
  }

  async on(event: string, listener: BlockListener): Promise<this> {
    if (event === "block") {
      this.blockListeners.push(listener);
    }
    return this;
  }

  async removeAllListeners(): Promise<this> {
    this.blockListeners = [];
    return this;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.websocket.close();
  }

  emitBlock(blockNumber: number): void {
    for (const listener of this.blockListeners) {
      listener(blockNumber);
    }
  }
}

// ---------------------------------------------------------------------------
// Patch ethers.WebSocketProvider at module level
// ---------------------------------------------------------------------------

let providerInstances: MockProvider[] = [];
let providerFactory: (url: string) => MockProvider = (url) => new MockProvider(url);

vi.mock("ethers", () => ({
  ethers: {
    WebSocketProvider: class {
      constructor(url: string) {
        const instance = providerFactory(url);
        providerInstances.push(instance);
        return instance;
      }
    },
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeChain(overrides?: Partial<ChainConfig>): ChainConfig {
  return {
    chainId: 1,
    name: "TestChain",
    defaultPrimaryWss: "wss://primary.test",
    defaultFallbackWss: "wss://fallback.test",
    ...overrides,
  };
}

function makeWorkflow(overrides?: Partial<BlockWorkflow>): BlockWorkflow {
  return {
    id: "wf-1",
    name: "Test Workflow",
    userId: "user-1",
    organizationId: null,
    network: "1",
    blockInterval: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChainMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    providerInstances = [];
    providerFactory = (url) => new MockProvider(url);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function latestProvider(): MockProvider {
    return providerInstances[providerInstances.length - 1];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("start / stop", () => {
    it("connects, subscribes, and reports alive after start", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      expect(monitor.isAlive()).toBe(true);
      expect(providerInstances).toHaveLength(1);
      expect(latestProvider().url).toBe("wss://primary.test");
    });

    it("reports not alive before start", () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      expect(monitor.isAlive()).toBe(false);
    });

    it("reports not alive after stop", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      await monitor.stop();

      expect(monitor.isAlive()).toBe(false);
    });

    it("throws and resets isRunning if connect fails with no WSS urls", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain({
          defaultPrimaryWss: null,
          defaultFallbackWss: null,
        }),
        workflows: [makeWorkflow()],
      });

      await expect(monitor.start()).rejects.toThrow("No WSS URLs configured");
      expect(monitor.isAlive()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Block subscription
  // -------------------------------------------------------------------------

  describe("block subscription", () => {
    it("awaits provider.on and sets hasActiveSubscription", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      expect(monitor.isAlive()).toBe(true);
      const provider = latestProvider();
      // Verify the on() was called - provider has block listeners
      // Emit a block to confirm the listener was wired up
      const { enqueueBlockTrigger } = await import("./sqs-enqueue.js");
      provider.emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(enqueueBlockTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: "wf-1",
          triggerData: expect.objectContaining({ blockNumber: 10 }),
        })
      );
    });

    it("only enqueues for blocks matching the interval", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 12 })],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import("./sqs-enqueue.js");
      const provider = latestProvider();

      provider.emitBlock(11);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).not.toHaveBeenCalled();

      provider.emitBlock(12);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      provider.emitBlock(13);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      provider.emitBlock(24);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(2);
    });

    it("deduplicates blocks with the same or lower number", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 1 })],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import("./sqs-enqueue.js");
      const provider = latestProvider();

      provider.emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      // Same block again
      provider.emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      // Lower block
      provider.emitBlock(9);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // WebSocket close and reconnection
  // -------------------------------------------------------------------------

  describe("reconnection", () => {
    it("reconnects when WebSocket closes", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(providerInstances).toHaveLength(1);

      // Simulate WebSocket close
      latestProvider().websocket.emit("close");

      // Advance past the reconnection delay (1s for first attempt)
      await vi.advanceTimersByTimeAsync(1500);

      expect(providerInstances).toHaveLength(2);
      expect(monitor.isAlive()).toBe(true);
    });

    it("clears hasActiveSubscription on WebSocket close", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(monitor.isAlive()).toBe(true);

      // Close the WebSocket - isAlive should still be true because
      // isReconnecting becomes true
      latestProvider().websocket.emit("close");
      expect(monitor.isAlive()).toBe(true);
    });

    it("reports alive during reconnection (isReconnecting guard)", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      // Trigger disconnect
      latestProvider().websocket.emit("close");

      // During the backoff delay, monitor should report alive
      // (isReconnecting = true)
      expect(monitor.isAlive()).toBe(true);
    });

    it("removes stale WebSocket close handler during destroyProvider", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      const firstProvider = latestProvider();
      const closeListenerCount = firstProvider.websocket.listenerCount("close");

      // Trigger reconnection
      firstProvider.websocket.emit("close");
      await vi.advanceTimersByTimeAsync(1500);

      // Old provider's close handler should have been removed
      expect(firstProvider.websocket.listenerCount("close")).toBeLessThan(
        closeListenerCount
      );
    });

    it("re-subscribes to blocks after reconnection", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 10 })],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import("./sqs-enqueue.js");

      // First provider delivers a matching block
      latestProvider().emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      // Disconnect and reconnect
      latestProvider().websocket.emit("close");
      await vi.advanceTimersByTimeAsync(1500);

      // Second provider delivers a matching block
      // Use block 20 (10 blocks later, within MAX_BACKFILL but only
      // block 20 matches interval=10)
      latestProvider().emitBlock(20);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(2);
    });

    it("does not double-trigger handleDisconnect when already reconnecting", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      // Trigger disconnect
      latestProvider().websocket.emit("close");

      // Trigger another close event while reconnecting
      latestProvider().websocket.emit("close");

      // Should only create one new provider
      await vi.advanceTimersByTimeAsync(1500);
      expect(providerInstances).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // isAlive
  // -------------------------------------------------------------------------

  describe("isAlive", () => {
    it("returns false when not started", () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });
      expect(monitor.isAlive()).toBe(false);
    });

    it("returns true when running with active subscription", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });
      await monitor.start();
      expect(monitor.isAlive()).toBe(true);
    });

    it("returns true when reconnecting (not dead, just recovering)", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });
      await monitor.start();
      latestProvider().websocket.emit("close");
      // Now isReconnecting=true, hasActiveSubscription=false
      expect(monitor.isAlive()).toBe(true);
    });

    it("returns false after stop", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });
      await monitor.start();
      await monitor.stop();
      expect(monitor.isAlive()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Config changes
  // -------------------------------------------------------------------------

  describe("hasConfigChanged", () => {
    it("detects primary WSS change", async () => {
      const chain = makeChain();
      const monitor = new ChainMonitor({
        chain,
        workflows: [makeWorkflow()],
      });

      expect(
        monitor.hasConfigChanged({
          ...chain,
          defaultPrimaryWss: "wss://new-primary.test",
        })
      ).toBe(true);
    });

    it("returns false when config unchanged", () => {
      const chain = makeChain();
      const monitor = new ChainMonitor({
        chain,
        workflows: [makeWorkflow()],
      });

      expect(monitor.hasConfigChanged(chain)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Fallback connection
  // -------------------------------------------------------------------------

  describe("fallback connection", () => {
    it("uses fallback WSS when primary fails", async () => {
      let callCount = 0;
      providerFactory = (url: string) => {
        callCount++;
        const instance = new MockProvider(url);
        if (callCount === 1) {
          instance.ready = Promise.reject(new Error("Primary down"));
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      expect(providerInstances).toHaveLength(2);
      expect(latestProvider().url).toBe("wss://fallback.test");
      expect(monitor.isAlive()).toBe(true);
    });
  });
});
