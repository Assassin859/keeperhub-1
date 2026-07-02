/**
 * Tier 1 simulations for chain 8453 (base).
 *
 * Gated on PROTOCOL_SIM_RPC_8453 pointing at an anvil fork of the chain; skips
 * cleanly when absent (CI without the fork, local without the rig).
 * Run via: scripts/protocol-local.sh sim
 */

import { describe } from "vitest";
import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { runSimulation } from "./_shared/simulate";

const CHAIN_ID = "8453";
const RPC_URL = process.env.PROTOCOL_SIM_RPC_8453;

describe.skipIf(!RPC_URL)("protocol simulation (base)", () => {
  for (const protocol of getRegisteredProtocols()) {
    if (!protocol.testData?.[CHAIN_ID]) {
      continue;
    }
    describe(protocol.slug, () => {
      runSimulation({
        protocol: protocol.slug,
        chainId: CHAIN_ID,
        rpcUrl: RPC_URL as string,
      });
    });
  }
});
