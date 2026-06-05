import type { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  MAX_BATCH_RETRIES,
  queryBatchWithRetry,
} from "@/plugins/web3/steps/query-events-core";

function mockRpc(
  executeWithFailover: ReturnType<typeof vi.fn>
): RpcProviderManager {
  return { executeWithFailover } as unknown as RpcProviderManager;
}

describe("queryBatchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns on the first attempt without retrying", async () => {
    const events = [{ blockNumber: 1 } as unknown as ethers.EventLog];
    const executeWithFailover = vi.fn().mockResolvedValue(events);

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      0,
      100
    );
    const expectation = expect(promise).resolves.toBe(events);
    await vi.runAllTimersAsync();
    await expectation;

    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });

  it("retries a transiently failing batch and returns once an attempt succeeds", async () => {
    const events = [{ blockNumber: 2 } as unknown as ethers.EventLog];
    const executeWithFailover = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC failed: Timeout after 30000ms"))
      .mockRejectedValueOnce(new Error("RPC failed: Timeout after 30000ms"))
      .mockResolvedValueOnce(events);

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      0,
      100
    );
    const expectation = expect(promise).resolves.toBe(events);
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
      100
    );
    const expectation = expect(promise).rejects.toBe(lastError);
    await vi.runAllTimersAsync();
    await expectation;

    expect(executeWithFailover).toHaveBeenCalledTimes(MAX_BATCH_RETRIES);
  });
});
