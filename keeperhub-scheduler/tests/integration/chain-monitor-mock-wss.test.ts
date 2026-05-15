/**
 * KEEP-570 - End-to-end validation of the diagnostic warning produced by
 * this PR, against the real ChainMonitor and real ethers v6.
 *
 * Unlike tests/unit/chain-monitor.test.ts which mocks ethers, this test
 * runs ChainMonitor against a real `ws` server we control. The server
 * implements each candidate failure mode; we observe the noBlockTimer
 * warning and verify that the (wsFrames, subscriptionPushes, blocksReceived)
 * triple in the warning correctly distinguishes the three modes.
 *
 * The reaper-side assertion (isAlive returns false past
 * MONITOR_RECREATE_TIMEOUT_MS while subscribe re-fires) belongs with the
 * companion PR that fixes the staleness-clock reset on reconnect; it is
 * out of scope here.
 *
 * This is a synthetic stuck state, not a reproduction of the actual prod
 * bug. It validates the discrimination logic end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ChainMonitor } from "../../block-dispatcher/chain-monitor.js";

vi.mock("../../block-dispatcher/sqs-enqueue.js", () => ({
  enqueueBlockTrigger: vi.fn().mockResolvedValue(undefined),
}));

const BLOCK_ADVANCE_MS = 2_000;
const MONITOR_RECREATE_MS = 6_000;
const PRIMARY_PROBE_INTERVAL_MS = 60_000;
const STUCK_WINDOW_MS = MONITOR_RECREATE_MS + 2_000;

type Scenario = "healthy" | "zombie" | "subscribe-no-response";

function startMockServer(
  port: number,
  scenario: Scenario,
): { server: WebSocketServer; serverStarted: Promise<void> } {
  let blockNumber = 0x1000;
  const server = new WebSocketServer({ port });
  const subscriptions = new Map<string, NodeJS.Timeout>();

  const serverStarted = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  function send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function pushNewHead(ws: WebSocket, subId: string): void {
    blockNumber++;
    const number = `0x${blockNumber.toString(16)}`;
    send(ws, {
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: {
        subscription: subId,
        result: {
          number,
          hash: `0x${blockNumber.toString(16).padStart(64, "a")}`,
          parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "b")}`,
          timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          baseFeePerGas: "0x1",
          miner: "0x0000000000000000000000000000000000000000",
          difficulty: "0x0",
        },
      },
    });
  }

  server.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg: { id?: number; method?: string; params?: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.method === "eth_chainId") {
        send(ws, { jsonrpc: "2.0", id: msg.id, result: "0x1" });
        return;
      }
      if (msg.method === "net_version") {
        send(ws, { jsonrpc: "2.0", id: msg.id, result: "1" });
        return;
      }
      if (msg.method === "eth_blockNumber") {
        send(ws, {
          jsonrpc: "2.0",
          id: msg.id,
          result: `0x${blockNumber.toString(16)}`,
        });
        return;
      }
      if (msg.method === "eth_subscribe") {
        const subId = `0x${Math.random()
          .toString(16)
          .slice(2)
          .padEnd(32, "0")}`;

        if (scenario === "subscribe-no-response") {
          const timer = setInterval(() => {
            pushNewHead(ws, subId);
          }, 200);
          subscriptions.set(subId, timer);
          return;
        }

        send(ws, { jsonrpc: "2.0", id: msg.id, result: subId });

        if (scenario === "zombie") {
          return;
        }

        const timer = setInterval(() => {
          pushNewHead(ws, subId);
        }, 200);
        subscriptions.set(subId, timer);
        return;
      }
      if (msg.method === "eth_unsubscribe") {
        send(ws, { jsonrpc: "2.0", id: msg.id, result: true });
        return;
      }
      send(ws, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method ${msg.method} not found` },
      });
    });

    ws.on("close", () => {
      for (const timer of subscriptions.values()) {
        clearInterval(timer);
      }
      subscriptions.clear();
    });
  });

  return { server, serverStarted };
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

function makeChain(port: number): {
  chainId: number;
  name: string;
  defaultPrimaryWss: string;
  defaultFallbackWss: null;
} {
  return {
    chainId: 1,
    name: "TestChain",
    defaultPrimaryWss: `ws://localhost:${port}`,
    defaultFallbackWss: null,
  };
}

// The benign destroy-race in chain-monitor.ts:
// subscriber.stop()'s .then microtask races provider.destroy(); the in-flight
// eth_unsubscribe rejects with "provider destroyed; cancelled request". This
// happens in prod on every teardown (53 in 5000 log lines, documented on
// KEEP-570) and propagates as an unhandled rejection. Swallow it here so
// vitest does not fail the run on what is documented benign noise.
function isBenignDestroyRace(reason: unknown): boolean {
  if (!(reason instanceof Error)) {
    return false;
  }
  const code = (reason as Error & { code?: string }).code;
  const operation = (reason as Error & { operation?: string }).operation;
  return code === "UNSUPPORTED_OPERATION" && operation === "eth_unsubscribe";
}

describe("KEEP-570 integration: ChainMonitor warning patterns against a real ws mock", () => {
  let serverHandle:
    | { server: WebSocketServer; serverStarted: Promise<void> }
    | null = null;
  let monitor: ChainMonitor | null = null;
  let warningCapture: { warnings: string[]; restore: () => void } | null =
    null;
  const rejectionHandler = (reason: unknown): void => {
    if (!isBenignDestroyRace(reason)) {
      throw reason;
    }
  };
  let port = 19100;

  beforeEach(() => {
    port++;
    vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", String(BLOCK_ADVANCE_MS));
    vi.stubEnv("MONITOR_RECREATE_TIMEOUT_MS", String(MONITOR_RECREATE_MS));
    vi.stubEnv(
      "PRIMARY_PROBE_INTERVAL_MS",
      String(PRIMARY_PROBE_INTERVAL_MS),
    );
    warningCapture = captureWarnings();
    process.on("unhandledRejection", rejectionHandler);
  });

  afterEach(async () => {
    if (monitor) {
      await monitor.stop().catch(() => {
        // ignore teardown errors; we have process-level handler
      });
      monitor = null;
    }
    if (serverHandle) {
      await new Promise<void>((resolve) => {
        serverHandle?.server.close(() => resolve());
      });
      serverHandle = null;
    }
    if (warningCapture) {
      warningCapture.restore();
      warningCapture = null;
    }
    process.off("unhandledRejection", rejectionHandler);
    vi.unstubAllEnvs();
  });

  it(
    "zombie mode -> warning shows subscriptionPushes=0, blocksReceived=0",
    async () => {
      serverHandle = startMockServer(port, "zombie");
      await serverHandle.serverStarted;

      monitor = new ChainMonitor({
        chain: makeChain(port),
        workflows: [{ id: "wf1", userId: "u1", blockInterval: 1 }],
      });

      await monitor.start();

      // Wait through at least one noBlockTimer firing plus reconnect.
      await new Promise((r) => setTimeout(r, STUCK_WINDOW_MS));

      const warning = warningCapture?.warnings.find((w) =>
        w.includes("Block height has not advanced"),
      );
      expect(
        warning,
        "expected at least one noBlockTimer warning",
      ).toBeDefined();
      // wsFrames > 0 because chainId/blockNumber/subscribe round-trips
      // produce non-subscription frames. subscriptionPushes is 0 because
      // the server never sends pushes in zombie mode.
      expect(warning).toMatch(/subscriptionPushes=0/);
      expect(warning).toMatch(/blocksReceived=0/);
    },
    30_000,
  );

  it(
    "subscribe-no-response mode -> warning shows subscriptionPushes>0, blocksReceived=0 (ethers routing bug)",
    async () => {
      serverHandle = startMockServer(port, "subscribe-no-response");
      await serverHandle.serverStarted;

      monitor = new ChainMonitor({
        chain: makeChain(port),
        workflows: [{ id: "wf1", userId: "u1", blockInterval: 1 }],
      });

      await monitor.start();
      await new Promise((r) => setTimeout(r, STUCK_WINDOW_MS));

      const warning = warningCapture?.warnings.find((w) =>
        w.includes("Block height has not advanced"),
      );
      expect(
        warning,
        "expected at least one noBlockTimer warning",
      ).toBeDefined();
      // Pushes are arriving (server sends eth_subscription messages with
      // the server-side known subId), but ethers never registered the
      // subscriber in #subs because the response was dropped. Frames show
      // in our raw-ws tap counter even though they never reach onBlock.
      expect(warning).toMatch(/subscriptionPushes=[1-9]/);
      expect(warning).toMatch(/blocksReceived=0/);
    },
    30_000,
  );

  it(
    "healthy mode -> blocks arrive, no stuck warning, isAlive stays true",
    async () => {
      serverHandle = startMockServer(port, "healthy");
      await serverHandle.serverStarted;

      monitor = new ChainMonitor({
        chain: makeChain(port),
        workflows: [{ id: "wf1", userId: "u1", blockInterval: 1 }],
      });

      await monitor.start();
      await new Promise((r) => setTimeout(r, STUCK_WINDOW_MS));

      const stuckWarning = warningCapture?.warnings.find((w) =>
        w.includes("Block height has not advanced"),
      );
      expect(
        stuckWarning,
        "should not see a stuck warning in healthy mode",
      ).toBeUndefined();
      expect(monitor.isAlive()).toBe(true);
    },
    30_000,
  );
});
