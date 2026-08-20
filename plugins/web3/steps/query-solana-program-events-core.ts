import "server-only";

import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getSolanaProvider } from "@/lib/rpc/provider-factory";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";
import { getErrorMessage } from "@/lib/utils";
import {
  type AnchorEventDecoder,
  createEventDecoder,
} from "@/lib/web3/anchor-events";

// Solana has no `eth_getLogs` equivalent: `getSignaturesForAddress` only
// takes `before`/`until` signature cursors (not a slot range) and returns no
// log data, so every signature in the window needs a follow-up
// `getTransaction` call to see its logs. These caps bound a single
// invocation's RPC cost and wall-clock time; hitting them surfaces as
// `truncated: true` with a cursor to continue, never a silent drop.
export const MAX_SIGNATURE_PAGES = 10;
export const MAX_SIGNATURES_PER_PAGE = 1000;
export const DEFAULT_SIGNATURE_LOOKBACK = 1000;
export const MAX_SIGNATURE_LOOKBACK =
  MAX_SIGNATURE_PAGES * MAX_SIGNATURES_PER_PAGE;
export const MAX_TRANSACTION_CONCURRENCY = 8;
export const MAX_PAGE_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 2000;

export type QuerySolanaProgramEventsCoreInput = {
  network: string;
  programId: string;
  idl?: string;
  eventName?: string;
  signatureLookback?: number | string;
  beforeSignature?: string;
  untilSignature?: string;
  _context?: {
    executionId?: string;
  };
};

export type SolanaProgramEvent = {
  signature: string;
  slot: number;
  blockTime: number | null;
  eventName?: string;
  args?: Record<string, unknown>;
  raw?: string[];
};

export type QuerySolanaProgramEventsResult =
  | {
      success: true;
      events: SolanaProgramEvent[];
      oldestSignature: string | null;
      newestSignature: string | null;
      signatureCount: number;
      eventCount: number;
      truncated: boolean;
      nextBeforeSignature: string | null;
    }
  | { success: false; error: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Non-throwing by design: RPC preferences are a per-user convenience, not an
// authority signal, so a lookup failure falls back to the chain's default RPC
// config rather than failing the query.
async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }
  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  return execution[0]?.userId;
}

function parseSignatureLookback(
  input: number | string | undefined
): { success: true; value: number } | { success: false; error: string } {
  if (input === undefined || input === null || input === "") {
    return { success: true, value: DEFAULT_SIGNATURE_LOOKBACK };
  }
  const parsed =
    typeof input === "number" ? input : Number.parseInt(input, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return {
      success: false,
      error: `Invalid signatureLookback value: ${input}`,
    };
  }
  return { success: true, value: Math.min(parsed, MAX_SIGNATURE_LOOKBACK) };
}

type ResolvedQuery = {
  programKey: PublicKey;
  decoder: AnchorEventDecoder | null;
  lookback: number;
  chainId: number;
};

function resolveQueryContext(
  input: QuerySolanaProgramEventsCoreInput
): { success: true; value: ResolvedQuery } | { success: false; error: string } {
  let programKey: PublicKey;
  try {
    programKey = new PublicKey(input.programId);
  } catch {
    return { success: false, error: `Invalid program ID: ${input.programId}` };
  }

  const decoder = createEventDecoder(input.idl);
  if (input.eventName && !decoder) {
    return {
      success: false,
      error:
        "eventName filtering requires a valid Anchor IDL in the idl field",
    };
  }

  const lookbackResult = parseSignatureLookback(input.signatureLookback);
  if (!lookbackResult.success) {
    return { success: false, error: lookbackResult.error };
  }

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  return {
    success: true,
    value: { programKey, decoder, lookback: lookbackResult.value, chainId },
  };
}

async function fetchSignaturePage(
  rpcManager: SolanaProviderManager,
  programKey: PublicKey,
  options: { before?: string; until?: string; limit: number }
): Promise<ConfirmedSignatureInfo[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PAGE_RETRIES; attempt++) {
    try {
      return await rpcManager.executeWithFailover((connection) =>
        connection.getSignaturesForAddress(programKey, options)
      );
    } catch (error) {
      lastError = error;
      if (attempt < MAX_PAGE_RETRIES) {
        await delay(RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Pages `getSignaturesForAddress` backward from `beforeSignature` (or the
 * newest signature, if unset) down to `untilSignature` (or the page/limit
 * caps), collecting up to `limit` signatures newest-first.
 */
async function collectSignatures(
  rpcManager: SolanaProviderManager,
  programKey: PublicKey,
  beforeSignature: string | undefined,
  untilSignature: string | undefined,
  limit: number
): Promise<{ signatures: ConfirmedSignatureInfo[]; truncated: boolean }> {
  const collected: ConfirmedSignatureInfo[] = [];
  let before = beforeSignature;
  let hitCap = false;

  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const remaining = limit - collected.length;
    if (remaining <= 0) {
      hitCap = true;
      break;
    }
    const pageLimit = Math.min(remaining, MAX_SIGNATURES_PER_PAGE);
    const batch = await fetchSignaturePage(rpcManager, programKey, {
      before,
      until: untilSignature,
      limit: pageLimit,
    });
    collected.push(...batch);
    if (batch.length < pageLimit) {
      // Fewer results than requested: no more history behind this cursor.
      break;
    }
    before = batch.at(-1)?.signature;
    if (page === MAX_SIGNATURE_PAGES - 1) {
      hitCap = true;
    }
  }

  return { signatures: collected, truncated: hitCap && collected.length > 0 };
}

async function fetchAndDecodeSignature(
  rpcManager: SolanaProviderManager,
  info: ConfirmedSignatureInfo,
  decoder: AnchorEventDecoder | null,
  eventName: string | undefined
): Promise<SolanaProgramEvent[]> {
  if (info.err) {
    // A failed instruction's events are not committed state; skip it,
    // matching the live event trigger's SignaturesSource behavior.
    return [];
  }

  const tx = await rpcManager.executeWithFailover((connection) =>
    connection.getTransaction(info.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
  );
  const logs = tx?.meta?.logMessages ?? [];

  if (!decoder) {
    return [
      {
        signature: info.signature,
        slot: info.slot,
        blockTime: info.blockTime ?? null,
        raw: logs,
      },
    ];
  }

  const decoded = decoder.decodeLogs(logs);
  const matched = eventName
    ? decoded.filter((event) => event.name === eventName)
    : decoded;

  return matched.map((event) => ({
    signature: info.signature,
    slot: info.slot,
    blockTime: info.blockTime ?? null,
    eventName: event.name,
    args: event.data,
  }));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const chunk = items.slice(start, start + concurrency);
    const chunkResults = await Promise.all(chunk.map((item) => fn(item)));
    results.push(...chunkResults);
  }
  return results;
}

export async function queryProgramEventsCore(
  input: QuerySolanaProgramEventsCoreInput
): Promise<QuerySolanaProgramEventsResult> {
  const resolved = resolveQueryContext(input);
  if (!resolved.success) {
    return { success: false, error: resolved.error };
  }
  const { programKey, decoder, lookback, chainId } = resolved.value;
  const eventName = input.eventName;

  const userId = await getUserIdFromExecution(input._context?.executionId);

  let rpcManager: SolanaProviderManager;
  try {
    rpcManager = await getSolanaProvider({ chainId, userId });
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  let signatures: ConfirmedSignatureInfo[];
  let truncated: boolean;
  try {
    const page = await collectSignatures(
      rpcManager,
      programKey,
      input.beforeSignature,
      input.untilSignature,
      lookback
    );
    signatures = page.signatures;
    truncated = page.truncated;
  } catch (error) {
    return {
      success: false,
      error: `Signature lookup failed: ${getErrorMessage(error)}`,
    };
  }

  if (signatures.length === 0) {
    return {
      success: true,
      events: [],
      oldestSignature: null,
      newestSignature: null,
      signatureCount: 0,
      eventCount: 0,
      truncated: false,
      nextBeforeSignature: null,
    };
  }

  // Newest-first from the RPC; process oldest-first so events in the output
  // are ordered the same way they occurred on-chain.
  const oldestFirst = [...signatures].reverse();

  let events: SolanaProgramEvent[];
  try {
    const perSignature = await mapWithConcurrency(
      oldestFirst,
      MAX_TRANSACTION_CONCURRENCY,
      (info) => fetchAndDecodeSignature(rpcManager, info, decoder, eventName)
    );
    events = perSignature.flat();
  } catch (error) {
    return {
      success: false,
      error: `Transaction fetch failed: ${getErrorMessage(error)}`,
    };
  }

  return {
    success: true,
    events,
    oldestSignature: oldestFirst[0].signature,
    newestSignature: oldestFirst.at(-1)?.signature ?? null,
    signatureCount: signatures.length,
    eventCount: events.length,
    truncated,
    nextBeforeSignature: truncated ? oldestFirst[0].signature : null,
  };
}
