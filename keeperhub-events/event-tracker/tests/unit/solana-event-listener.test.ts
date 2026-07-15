import type { SQSClient } from "@aws-sdk/client-sqs";
import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import type {
  Commitment,
  ConfirmedSignatureInfo,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaProviderManager } from "../../src/chains/solana-provider-manager";
import type { DedupStore } from "../../src/listener/dedup";
import {
  SolanaEventListener,
  type SolanaEventListenerOptions,
} from "../../src/listener/solana-event-listener";

const { createPhantomExecution, failPhantomExecution } = vi.hoisted(() => ({
  createPhantomExecution: vi.fn(),
  failPhantomExecution: vi.fn(),
}));
vi.mock("../../lib/phantom", () => ({
  createPhantomExecution,
  failPhantomExecution,
}));

const WORKFLOW_ID = "wf-sol";
const USER_ID = "user-1";
const PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SQS_QUEUE_URL = "https://sqs.test/queue";
const CHAIN_ID = 103;

// Anchor fixture for typed-mode tests (mirrors solana-idl.test.ts).
const DISCRIMINATOR = [11, 22, 33, 44, 55, 66, 77, 88];
const IDL: Idl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "test_program", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [],
  events: [{ name: "Deposited", discriminator: DISCRIMINATOR }],
  types: [
    {
      name: "Deposited",
      type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] },
    },
  ],
};
function anchorEventLog(amount: number): string {
  const coder = new BorshCoder(IDL);
  const encoded = coder.types.encode("Deposited", { amount: new BN(amount) });
  const blob = Buffer.concat([Buffer.from(DISCRIMINATOR), encoded]);
  return `Program data: ${blob.toString("base64")}`;
}

function sig(signature: string, slot: number): ConfirmedSignatureInfo {
  return {
    signature,
    slot,
    err: null,
    memo: null,
    blockTime: null,
  };
}

interface SolProviderMock {
  manager: SolanaProviderManager;
  fireSlot: () => void;
  getSignaturesForAddress: ReturnType<typeof vi.fn>;
  getTransaction: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  setNewSignatures: (list: ConfirmedSignatureInfo[]) => void;
  setLogs: (signature: string, logs: string[]) => void;
}

function makeProviderMock(): SolProviderMock {
  let handler: (() => void) | null = null;
  let newSignatures: ConfirmedSignatureInfo[] = [];
  const logsBySig = new Map<string, string[]>();
  const unsubscribe = vi.fn();

  const subscribeToSlots = vi.fn(
    (opts: { handler: (slot: number) => void }) => {
      handler = () => opts.handler(1);
      return unsubscribe;
    },
  );
  const getSignaturesForAddress = vi.fn(
    async (
      _chainId: number,
      _address: string,
      options: { until?: string; limit?: number },
    ): Promise<ConfirmedSignatureInfo[]> => {
      // Seed call (no cursor) returns the current head; poll call returns the
      // queued new signatures.
      if (!options.until) {
        return [sig("seed0", 1)];
      }
      return newSignatures;
    },
  );
  const getTransaction = vi.fn(
    async (
      _chainId: number,
      signature: string,
    ): Promise<VersionedTransactionResponse | null> => {
      const logMessages = logsBySig.get(signature) ?? [
        `Program log: ${signature}`,
      ];
      return {
        meta: { logMessages },
      } as unknown as VersionedTransactionResponse;
    },
  );

  const manager = {
    subscribeToSlots,
    getSignaturesForAddress,
    getTransaction,
  } as unknown as SolanaProviderManager;

  return {
    manager,
    fireSlot: () => handler?.(),
    getSignaturesForAddress,
    getTransaction,
    unsubscribe: unsubscribe as ReturnType<typeof vi.fn>,
    setNewSignatures: (list) => {
      newSignatures = list;
    },
    setLogs: (signature, logs) => {
      logsBySig.set(signature, logs);
    },
  };
}

function makeDedupMock(): DedupStore & {
  isProcessed: ReturnType<typeof vi.fn>;
  markProcessed: ReturnType<typeof vi.fn>;
} {
  return {
    isProcessed: vi.fn(async () => false),
    markProcessed: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  } as DedupStore & {
    isProcessed: ReturnType<typeof vi.fn>;
    markProcessed: ReturnType<typeof vi.fn>;
  };
}

function makeSqsMock(): SQSClient & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => ({ MessageId: "msg-1" })),
  } as unknown as SQSClient & { send: ReturnType<typeof vi.fn> };
}

function buildOptions(
  provider: SolProviderMock,
  overrides: Partial<SolanaEventListenerOptions> = {},
): SolanaEventListenerOptions {
  return {
    workflowId: WORKFLOW_ID,
    userId: USER_ID,
    workflowName: "Solana Unit Test",
    chainId: CHAIN_ID,
    rpcUrl: "https://api.devnet.solana.com",
    wssUrl: "wss://api.devnet.solana.com",
    programId: PROGRAM_ID,
    commitment: "confirmed" as Commitment,
    sqs: makeSqsMock(),
    sqsQueueUrl: SQS_QUEUE_URL,
    dedup: makeDedupMock(),
    providerManager: provider.manager,
    jitterMs: 0,
    pollDebounceMs: 0,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("SolanaEventListener", () => {
  beforeEach(() => {
    createPhantomExecution.mockReset();
    failPhantomExecution.mockReset();
  });

  it("seeds the cursor and subscribes to slots on start", async () => {
    const provider = makeProviderMock();
    const listener = new SolanaEventListener(buildOptions(provider));
    await listener.start();

    // Seed call: no cursor, limit 1.
    const seedCall = provider.getSignaturesForAddress.mock.calls[0];
    expect(seedCall[3]).toBe("confirmed");
    expect(seedCall[2]).toMatchObject({ limit: 1 });
    expect(listener.isStarted()).toBe(true);
  });

  it("raw mode: a new signature on a slot tick enqueues to SQS", async () => {
    const provider = makeProviderMock();
    const sqs = makeSqsMock();
    const dedup = makeDedupMock();
    const listener = new SolanaEventListener(
      buildOptions(provider, { sqs, dedup }),
    );
    await listener.start();

    provider.setNewSignatures([sig("sigA", 5)]);
    provider.fireSlot();
    await vi.waitFor(() => expect(sqs.send).toHaveBeenCalledTimes(1));

    expect(dedup.markProcessed).toHaveBeenCalledWith(WORKFLOW_ID, "sigA");
    const command = sqs.send.mock.calls[0][0] as {
      input: {
        MessageBody: string;
        MessageAttributes: Record<string, { StringValue: string }>;
      };
    };
    expect(command.input.MessageAttributes.TriggerType.StringValue).toBe(
      "event",
    );
    const body = JSON.parse(command.input.MessageBody) as {
      triggerType: string;
      triggerData: {
        chainType: string;
        signature: string;
        slot: number;
        logs: string[];
      };
    };
    expect(body.triggerType).toBe("event");
    expect(body.triggerData.chainType).toBe("solana");
    expect(body.triggerData.signature).toBe("sigA");
    expect(body.triggerData.slot).toBe(5);
    expect(body.triggerData.logs).toContain("Program log: sigA");
  });

  it("dedup hit -> skips SQS", async () => {
    const provider = makeProviderMock();
    const sqs = makeSqsMock();
    const dedup = makeDedupMock();
    dedup.isProcessed.mockResolvedValue(true);
    const listener = new SolanaEventListener(
      buildOptions(provider, { sqs, dedup }),
    );
    await listener.start();

    provider.setNewSignatures([sig("sigA", 5)]);
    provider.fireSlot();
    await settle();

    expect(sqs.send).not.toHaveBeenCalled();
    expect(dedup.markProcessed).not.toHaveBeenCalled();
  });

  it("advances the cursor so the next poll queries until the newest signature", async () => {
    const provider = makeProviderMock();
    const listener = new SolanaEventListener(buildOptions(provider));
    await listener.start();

    provider.setNewSignatures([sig("sigA", 5)]);
    provider.fireSlot();
    await settle();

    provider.setNewSignatures([]);
    provider.fireSlot();
    await settle();

    const pollCalls = provider.getSignaturesForAddress.mock.calls.filter(
      (c) => (c[2] as { until?: string }).until !== undefined,
    );
    expect(pollCalls.at(-1)?.[2]).toMatchObject({ until: "sigA" });
  });

  it("eventName set without an IDL degrades to raw mode (still fires)", async () => {
    const provider = makeProviderMock();
    const sqs = makeSqsMock();
    const listener = new SolanaEventListener(
      buildOptions(provider, { sqs, eventName: "Deposited" }),
    );
    await listener.start();

    provider.setNewSignatures([sig("sigA", 5)]);
    provider.fireSlot();
    await vi.waitFor(() => expect(sqs.send).toHaveBeenCalledTimes(1));
  });

  describe("typed mode", () => {
    it("fires and attaches decoded events when the named event is present", async () => {
      const provider = makeProviderMock();
      const sqs = makeSqsMock();
      const listener = new SolanaEventListener(
        buildOptions(provider, {
          sqs,
          idl: JSON.stringify(IDL),
          eventName: "Deposited",
        }),
      );
      await listener.start();

      provider.setLogs("sigA", [anchorEventLog(7)]);
      provider.setNewSignatures([sig("sigA", 5)]);
      provider.fireSlot();
      await vi.waitFor(() => expect(sqs.send).toHaveBeenCalledTimes(1));

      const body = JSON.parse(
        (sqs.send.mock.calls[0][0] as { input: { MessageBody: string } }).input
          .MessageBody,
      ) as {
        triggerData: {
          eventName: string;
          events: { name: string; data: { amount: { value: string } } }[];
        };
      };
      expect(body.triggerData.eventName).toBe("Deposited");
      expect(body.triggerData.events[0].name).toBe("Deposited");
      expect(body.triggerData.events[0].data.amount.value).toBe("7");
    });

    it("skips a tx that does not emit the named event", async () => {
      const provider = makeProviderMock();
      const sqs = makeSqsMock();
      const listener = new SolanaEventListener(
        buildOptions(provider, {
          sqs,
          idl: JSON.stringify(IDL),
          eventName: "Deposited",
        }),
      );
      await listener.start();

      provider.setLogs("sigA", ["Program log: unrelated"]);
      provider.setNewSignatures([sig("sigA", 5)]);
      provider.fireSlot();
      await settle();

      expect(sqs.send).not.toHaveBeenCalled();
    });
  });
});
