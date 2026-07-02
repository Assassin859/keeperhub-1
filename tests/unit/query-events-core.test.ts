import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcProviderManager } from "@/lib/rpc/providers";

const mockQueryFilter = vi.fn();

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        filters = { Lift: () => ({ topics: [] }) };
        queryFilter = mockQueryFilter;
      },
    },
  };
});

import {
  MAX_BATCH_RETRIES,
  queryBatchWithRetry,
} from "@/plugins/web3/steps/query-events-core";

function mockRpc(
  executeWithFailover: ReturnType<typeof vi.fn>
): RpcProviderManager {
  return { executeWithFailover } as unknown as RpcProviderManager;
}

function fakeProvider(head: number): { getBlockNumber: () => Promise<number> } {
  return { getBlockNumber: () => Promise.resolve(head) };
}

describe("queryBatchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockQueryFilter.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns on the first attempt without retrying (non-tip batch)", async () => {
    const events = [{ blockNumber: 1 }];
    mockQueryFilter.mockResolvedValue(events);
    const executeWithFailover = vi.fn((operation) =>
      operation(fakeProvider(999))
    );

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      0,
      100,
      false
    );
    const expectation = expect(promise).resolves.toEqual({
      events,
      actualEnd: 100,
    });
    await vi.runAllTimersAsync();
    await expectation;

    expect(mockQueryFilter).toHaveBeenCalledWith(expect.anything(), 0, 100);
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });

  it("retries a transiently failing batch and returns once an attempt succeeds", async () => {
    const events = [{ blockNumber: 2 }];
    const executeWithFailover = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC failed: Timeout after 30000ms"))
      .mockRejectedValueOnce(new Error("RPC failed: Timeout after 30000ms"))
      .mockResolvedValueOnce({ events, actualEnd: 100 });

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      0,
      100,
      false
    );
    const expectation = expect(promise).resolves.toEqual({
      events,
      actualEnd: 100,
    });
    await vi.runAllTimersAsync();
    await expectation;

    expect(executeWithFailover).toHaveBeenCalledTimes(3);
  });

  it("gives up and throws after MAX_BATCH_RETRIES failed attempts", async () => {
    const lastError = new Error("RPC failed: Timeout after 30000ms");
    const executeWithFailover = vi.fn().mockRejectedValue(lastError);

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      0,
      100,
      false
    );
    const expectation = expect(promise).rejects.toBe(lastError);
    await vi.runAllTimersAsync();
    await expectation;

    expect(executeWithFailover).toHaveBeenCalledTimes(MAX_BATCH_RETRIES);
  });

  it("queries a tip batch against the literal 'latest' tag and reports the parallel head fetch as actualEnd", async () => {
    const events = [{ blockNumber: 205 }];
    mockQueryFilter.mockResolvedValue(events);
    const executeWithFailover = vi.fn((operation) =>
      operation(fakeProvider(205))
    );

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      200,
      200,
      true
    );
    const expectation = expect(promise).resolves.toEqual({
      events,
      actualEnd: 205,
    });
    await vi.runAllTimersAsync();
    await expectation;

    // The literal "latest" tag, not a previously-resolved number, is what
    // makes this immune to the fast-replica/slow-replica race: whichever
    // node answers resolves "latest" against its own head.
    expect(mockQueryFilter).toHaveBeenCalledWith(
      expect.anything(),
      200,
      "latest"
    );
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });

  it("reports actualEnd from the head fetch even when it disagrees with the originally planned end", async () => {
    // The planned `end` (200) is only used for the outer batch loop's
    // bookkeeping; the tip batch's actual query and its reported actualEnd
    // are both driven by the live head, which can have moved past (or, in
    // this case, sit below) that original estimate without causing an error.
    const events: unknown[] = [];
    mockQueryFilter.mockResolvedValue(events);
    const executeWithFailover = vi.fn((operation) =>
      operation(fakeProvider(150))
    );

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      100,
      200,
      true
    );
    const expectation = expect(promise).resolves.toEqual({
      events,
      actualEnd: 150,
    });
    await vi.runAllTimersAsync();
    await expectation;
  });
});
