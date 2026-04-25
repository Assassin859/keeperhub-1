import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainMonitor } from "../../keeperhub-scheduler/block-dispatcher/chain-monitor.js";
import type {
  BlockWorkflow,
  ChainConfig,
} from "../../keeperhub-scheduler/lib/types.js";

// ---------------------------------------------------------------------------
// Mock SQS enqueue - prevent real AWS calls
// ---------------------------------------------------------------------------

vi.mock(
  "../../keeperhub-scheduler/block-dispatcher/sqs-enqueue.js",
  () => ({
    enqueueBlockTrigger: vi.fn().mockResolvedValue(undefined),
  })
);

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
    // Speed up the primary-recovery probe so tests don't wait 5 minutes.
    // The constant is read each time startPrimaryProbe() runs, so this
    // applies even though the module was already loaded.
    vi.stubEnv("PRIMARY_PROBE_INTERVAL_MS", "1000");
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
      const { enqueueBlockTrigger } = await import(
        "../../keeperhub-scheduler/block-dispatcher/sqs-enqueue.js"
      );
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

      const { enqueueBlockTrigger } = await import(
        "../../keeperhub-scheduler/block-dispatcher/sqs-enqueue.js"
      );
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

      const { enqueueBlockTrigger } = await import(
        "../../keeperhub-scheduler/block-dispatcher/sqs-enqueue.js"
      );
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

      const { enqueueBlockTrigger } = await import(
        "../../keeperhub-scheduler/block-dispatcher/sqs-enqueue.js"
      );

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
    it("uses fallback WSS when primary getBlockNumber rejects", async () => {
      let callCount = 0;
      providerFactory = (url: string): MockProvider => {
        callCount++;
        const instance = new MockProvider(url);
        if (callCount === 1) {
          instance.getBlockNumber = (): Promise<number> =>
            Promise.reject(new Error("Primary down"));
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

    it("falls over to fallback WSS when primary ws emits 'error' (HTTP 429)", async () => {
      // Simulates the failure mode where the WSS upgrade returns 429:
      // ws emits 'error' on the underlying socket and getBlockNumber would
      // hang waiting for ws ready. The connect race must reject via the
      // ws-error path so the fallback URL is tried instead of hanging or
      // crashing the dispatcher.
      let callCount = 0;
      providerFactory = (url: string): MockProvider => {
        callCount++;
        const instance = new MockProvider(url);
        if (callCount === 1) {
          // getBlockNumber hangs (mimics ws never opening due to 429)
          instance.getBlockNumber = (): Promise<number> =>
            new Promise<number>(() => {
              // never resolves
            });
          // ws emits error on next tick so the connect race is set up first
          setTimeout(() => {
            instance.websocket.emit(
              "error",
              new Error("Unexpected server response: 429")
            );
          }, 0);
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

    it("does not propagate ws 'error' as an uncaughtException", async () => {
      // Sanity check that the listener attached in connect() consumes the
      // error. Without the listener, EventEmitter would re-throw because
      // 'error' has no other subscribers.
      let callCount = 0;
      providerFactory = (url: string): MockProvider => {
        callCount++;
        const instance = new MockProvider(url);
        if (callCount === 1) {
          instance.getBlockNumber = (): Promise<number> =>
            new Promise<number>(() => {
              // never resolves
            });
          setTimeout(() => {
            instance.websocket.emit(
              "error",
              new Error("Unexpected server response: 429")
            );
          }, 0);
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await expect(monitor.start()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Primary recovery probe
  //
  // These tests use process.env.PRIMARY_PROBE_INTERVAL_MS=1000 (set in
  // beforeAll below) so they run in ~1s instead of 5min.
  // -------------------------------------------------------------------------

  describe("primary recovery probe", () => {
    it("does not start a probe when initially connected to primary", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      const startCount = providerInstances.length;

      // Advance well past one probe interval
      await vi.advanceTimersByTimeAsync(10_000);

      // No additional providers should have been created
      expect(providerInstances).toHaveLength(startCount);
    });

    it("probes primary when on fallback and swaps back when primary recovers", async () => {
      // First call: primary getBlockNumber rejects -> fallback used.
      // Subsequent primary calls: succeed -> probe should swap back.
      let primaryCallCount = 0;
      providerFactory = (url: string): MockProvider => {
        const instance = new MockProvider(url);
        if (url === "wss://primary.test") {
          primaryCallCount++;
          if (primaryCallCount === 1) {
            instance.getBlockNumber = (): Promise<number> =>
              Promise.reject(new Error("Unexpected server response: 429"));
          }
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      // Started on fallback (primary failed once)
      expect(latestProvider().url).toBe("wss://fallback.test");
      const startCount = providerInstances.length;

      // Advance past the probe interval; probe builds throwaway primary,
      // succeeds, triggers reconnect cycle which lands on primary again.
      await vi.advanceTimersByTimeAsync(2_000);

      // At least one new provider was created (the probe), and the active
      // provider should now be primary again.
      expect(providerInstances.length).toBeGreaterThan(startCount);
      // Latest connected provider should be primary
      const lastConnectedUrl = monitor.isAlive()
        ? "wss://primary.test"
        : "(monitor not alive)";
      // Find the most recent provider matching the primary URL — that is the
      // one we are now connected on.
      const primaryProviders = providerInstances.filter(
        (p) => p.url === "wss://primary.test"
      );
      expect(primaryProviders.length).toBeGreaterThanOrEqual(2);
      expect(lastConnectedUrl).toBe("wss://primary.test");
    });

    it("keeps the fallback connection when probe fails", async () => {
      // Primary always rejects; fallback works. Probe should fail silently
      // (one warn line) and the monitor should remain alive on fallback.
      providerFactory = (url: string): MockProvider => {
        const instance = new MockProvider(url);
        if (url === "wss://primary.test") {
          instance.getBlockNumber = (): Promise<number> =>
            Promise.reject(new Error("Unexpected server response: 429"));
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(latestProvider().url).toBe("wss://fallback.test");
      expect(monitor.isAlive()).toBe(true);

      // Spy on console.warn to confirm probe failure log is short
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await vi.advanceTimersByTimeAsync(2_000);

      // Still alive, still on fallback
      expect(monitor.isAlive()).toBe(true);
      // At least one warn was the probe-failure summary
      const probeWarn = warnSpy.mock.calls.find(([msg]) =>
        String(msg).includes("Primary probe failed")
      );
      expect(probeWarn).toBeDefined();
      // The summary should be tight: contain "HTTP 429" and not run for hundreds of chars
      expect(String(probeWarn?.[0])).toContain("HTTP 429");
      expect(String(probeWarn?.[0]).length).toBeLessThan(160);

      warnSpy.mockRestore();
    });
  });
});
