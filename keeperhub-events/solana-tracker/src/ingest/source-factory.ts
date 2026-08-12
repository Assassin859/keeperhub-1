import type { BlockSource, BlockSourceOptions } from "./block-source";
import { CompositeSource } from "./composite-source";
import { GetBlockSource } from "./getblock-source";
import { GeyserSource } from "./geyser-source";
import { SignaturesSource } from "./signatures-source";

/**
 * Ingestion strategy per chain, all satisfying the same BlockSource contract:
 *   - "getblock"    : whole-block pull, batched but unfiltered. Serves BOTH event
 *                     and block triggers. Cheap on low-volume chains only.
 *   - "signatures"  : getSignaturesForAddress per program - server-side filtered
 *                     (the EVM eth_getLogs analog), event triggers only.
 *   - Geyser        : filtered + batched + pushed gRPC stream (mainnet scale).
 */
export type SourceMode = "getblock" | "signatures";

export interface GeyserConfig {
  endpoint: string;
  token?: string;
}

export interface SourceSelection {
  geyser?: GeyserConfig;
  sourceMode?: SourceMode;
  hasBlockTriggers?: boolean;
}

export function createBlockSource(
  opts: BlockSourceOptions,
  selection: SourceSelection = {},
): BlockSource {
  if (selection.geyser) {
    return new GeyserSource({
      ...opts,
      geyserEndpoint: selection.geyser.endpoint,
      geyserToken: selection.geyser.token,
    });
  }
  if (selection.sourceMode === "signatures") {
    if (selection.hasBlockTriggers) {
      // The signatures source emits one-tx blocks with no header, so it cannot
      // serve block triggers. Pair it with a header-only getBlock (no watched
      // programs -> transactionDetails "none") rather than reverting the whole
      // chain to getBlock: that revert would put event matching back on the
      // full-block firehose, which is unaffordable at mainnet throughput.
      return new CompositeSource(opts.chainId, opts.endpoints, [
        new SignaturesSource(opts),
        new GetBlockSource({ ...opts, watchedProgramIds: [] }),
      ]);
    }
    return new SignaturesSource(opts);
  }
  return new GetBlockSource(opts);
}
