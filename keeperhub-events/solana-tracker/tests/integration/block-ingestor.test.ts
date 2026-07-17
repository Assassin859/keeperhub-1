import type { SQSClient } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DedupStore } from "../../src/dedup";
import { BlockIngestor } from "../../src/ingest/block-ingestor";
import type { NormalizedBlock, NormalizedTx } from "../../src/match/types";
import type { ChainRegistration } from "../../src/registrations";

const PROGRAM = "So11111111111111111111111111111111111111112";

// Captured onBlock + enqueue/phantom spies. Hoisted so the vi.mock factories
// (themselves hoisted above imports) can close over them.
const mocks = vi.hoisted(() => ({
  onBlock: null as ((block: unknown) => Promise<void>) | null,
  enqueueEvent: vi.fn(() => Promise.resolve()),
  enqueueBlock: vi.fn(() => Promise.resolve()),
  createPhantom: vi.fn(() => Promise.resolve("exec-1")),
  failPhantom: vi.fn(() => Promise.resolve()),
}));

// Replace the ingestion source with a stub that captures the onBlock the
// ingestor wires in, so the test can drive a NormalizedBlock through the real
// matcher -> decode -> dedup -> enqueue path without any network.
vi.mock("@/src/ingest/source-factory", () => ({
  createBlockSource: (opts: { onBlock: (block: unknown) => Promise<void> }) => {
    mocks.onBlock = opts.onBlock;
    return {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      getHealth: () => ({}),
    };
  },
}));

vi.mock("@/lib/phantom", () => ({
  createPhantomExecution: mocks.createPhantom,
  failPhantomExecution: mocks.failPhantom,
}));

vi.mock("@/lib/workflow-sqs", () => ({
  enqueueWorkflowEventTrigger: mocks.enqueueEvent,
  enqueueWorkflowBlockTrigger: mocks.enqueueBlock,
}));

function registration(): ChainRegistration {
  return {
    chainId: 101,
    rpcUrl: "https://rpc",
    wssUrl: "wss://ws",
    commitment: "confirmed",
    eventTriggers: [
      {
        workflowId: "wf-event",
        userId: "user-1",
        workflowName: "event",
        programId: PROGRAM,
        configHash: "h",
      },
    ],
    blockTriggers: [
      {
        workflowId: "wf-block",
        userId: "user-1",
        workflowName: "block",
        blockInterval: 5,
        configHash: "h",
      },
    ],
    configHash: "chain-hash",
  };
}

function block(tx: Partial<NormalizedTx> = {}): NormalizedBlock {
  return {
    slot: 100,
    blockHeight: 10, // divisible by the block trigger's interval (5)
    blockhash: "hash",
    blockTime: 1_700_000_000,
    parentSlot: 99,
    transactions: [
      {
        signature: "sig-1",
        programIds: [PROGRAM],
        logMessages: ["Program log: hi"],
        failed: false,
        ...tx,
      },
    ],
  };
}

function fakeDedup(isProcessed: boolean): DedupStore {
  return {
    isProcessed: vi.fn(() => Promise.resolve(isProcessed)),
    markProcessed: vi.fn(() => Promise.resolve()),
  } as unknown as DedupStore;
}

async function startIngestor(dedup: DedupStore): Promise<void> {
  const ingestor = new BlockIngestor({
    registration: registration(),
    sqs: undefined as unknown as SQSClient,
    sqsQueueUrl: "queue-url",
    dedup,
  });
  await ingestor.start();
}

beforeEach(() => {
  mocks.onBlock = null;
  vi.clearAllMocks();
});

describe("BlockIngestor end-to-end fan-out", () => {
  it("enqueues one event and one block message for a matching block", async () => {
    const dedup = fakeDedup(false);
    await startIngestor(dedup);
    expect(mocks.onBlock).toBeTypeOf("function");

    await mocks.onBlock?.(block());

    expect(mocks.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueBlock).toHaveBeenCalledTimes(1);
    expect(dedup.markProcessed).toHaveBeenCalledWith("wf-event", "sig-1");

    const eventArg = mocks.enqueueEvent.mock.calls[0][2] as {
      workflowId: string;
      triggerData: { chainType: string; programId: string };
    };
    expect(eventArg.workflowId).toBe("wf-event");
    expect(eventArg.triggerData.chainType).toBe("solana");
    expect(eventArg.triggerData.programId).toBe(PROGRAM);
  });

  it("skips the event enqueue when dedup reports it already processed", async () => {
    const dedup = fakeDedup(true);
    await startIngestor(dedup);

    await mocks.onBlock?.(block());

    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    // Block triggers are not deduped by signature, so the block still fires.
    expect(mocks.enqueueBlock).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue an event for a failed transaction, but still fires the block", async () => {
    const dedup = fakeDedup(false);
    await startIngestor(dedup);

    await mocks.onBlock?.(block({ failed: true }));

    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    expect(mocks.enqueueBlock).toHaveBeenCalledTimes(1);
  });
});
