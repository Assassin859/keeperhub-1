import { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";

export type AbiEntry = { type: string; name: string };

// A single batch can transiently time out on both RPC endpoints during a long
// scan (e.g. 30-60 day event ranges). Rather than failing the whole node (and
// having the durable engine replay the entire multi-minute scan), retry the
// failing batch with a backoff so a blip does not sink the run.
export const MAX_BATCH_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Query a single block range, failing over between RPC endpoints AND retrying
// the batch with a backoff (at least MAX_BATCH_RETRIES attempts) before giving
// up. A timed-out batch is the common transient failure on long scans; this
// keeps it from sinking the whole node.
export async function queryBatchWithRetry(
  rpcManager: RpcProviderManager,
  contractAddress: string,
  parsedAbi: AbiEntry[],
  eventName: string,
  start: number,
  end: number
): Promise<(ethers.Log | ethers.EventLog)[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
    try {
      return await rpcManager.executeWithFailover(async (provider) => {
        const contract = new ethers.Contract(
          contractAddress,
          parsedAbi,
          provider
        );
        const eventFilter = contract.filters[eventName]?.();
        if (eventFilter === undefined || eventFilter === null) {
          throw new Error(`Could not create filter for event '${eventName}'`);
        }
        return await contract.queryFilter(eventFilter, start, end);
      });
    } catch (error) {
      lastError = error;
      console.log(
        `[Query Events] Batch ${start}-${end} failed (attempt ${attempt}/${MAX_BATCH_RETRIES}): ${getErrorMessage(error)}`
      );
      if (attempt < MAX_BATCH_RETRIES) {
        await delay(RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}
