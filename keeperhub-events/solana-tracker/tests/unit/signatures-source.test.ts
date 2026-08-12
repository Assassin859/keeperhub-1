import { afterEach, describe, expect, it, vi } from "vitest";

// Controllable stand-in for the per-chain Solana connection so the source's
// poll cadence can be driven deterministically without any network.
const hooks = vi.hoisted(() => ({
  onSlot: null as null | ((slot: number) => void),
  signatureCalls: [] as { address: string; until?: string }[],
  signatures: (_address: string): { signature: string; slot: number }[] => [],
}));

vi.mock("@/src/ingest/solana-connection", () => ({
  SolanaConnection: class {
    constructor(opts: { onSlot: (slot: number) => void }) {
      hooks.onSlot = opts.onSlot;
    }
    start(): void {
      /* no-op mock */
    }
    stop(): Promise<void> {
      return Promise.resolve();
    }
    getSignaturesForAddress(
      address: string,
      options: { until?: string },
    ): Promise<unknown[]> {
      hooks.signatureCalls.push({ address, until: options.until });
      return Promise.resolve(hooks.signatures(address));
    }
    getTransaction(): Promise<unknown> {
      return Promise.resolve({ meta: { logMessages: [] }, blockTime: 0 });
    }
    getHealth(): unknown {
      return {};
    }
  },
}));

const { SignaturesSource } = await import("@/src/ingest/signatures-source");

const PROGRAM = "So11111111111111111111111111111111111111112";
const POLL_INTERVAL_MS = 1000;

function source(): InstanceType<typeof SignaturesSource> {
  return new SignaturesSource(
    {
      chainId: 101,
      endpoints: [{ rpcUrl: "r", wssUrl: "w" }],
      commitment: "confirmed",
      watchedProgramIds: [PROGRAM],
      onBlock: () => Promise.resolve(),
    },
    POLL_INTERVAL_MS,
  );
}

afterEach(() => {
  vi.useRealTimers();
  hooks.signatureCalls = [];
  hooks.signatures = () => [];
});

describe("SignaturesSource poll throttle", () => {
  it("coalesces a burst of slot ticks into one deferred poll", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    // start() seeds one cursor per watched program.
    expect(hooks.signatureCalls).toHaveLength(1);

    hooks.signatures = () => [];

    // Solana mainnet delivers ~2.5 slot ticks/s. Honouring each one would issue
    // a query per program per tick; they must collapse to one poll instead.
    for (let slot = 1; slot <= 5; slot++) {
      hooks.onSlot?.(slot);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(2);

    // The ticks that arrived inside the interval are not dropped - they fire as
    // a single poll once the interval elapses.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(hooks.signatureCalls).toHaveLength(3);

    // With no further ticks the source goes quiet rather than free-running.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(hooks.signatureCalls).toHaveLength(3);

    await src.stop();
  });

  it("polls immediately when a tick arrives after the interval has elapsed", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    hooks.signatures = () => [];

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    hooks.onSlot?.(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(3);

    await src.stop();
  });

  it("cancels a deferred poll on stop", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    hooks.signatures = () => [];

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(0);
    hooks.onSlot?.(2); // deferred to the interval boundary
    const callsBeforeStop = hooks.signatureCalls.length;

    await src.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(hooks.signatureCalls).toHaveLength(callsBeforeStop);

    await src.stop();
  });
});
