/**
 * Tier 1 simulations for chain 11155111 (sepolia).
 *
 * Gated on PROTOCOL_SIM_RPC_11155111 pointing at an anvil fork of the chain; skips
 * cleanly when absent (CI without the fork, local without the rig).
 * Run via: scripts/protocol-local.sh sim
 */

import { describe } from "vitest";
import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { runSimulation } from "./_shared/simulate";

const CHAIN_ID = "11155111";
const RPC_URL = process.env.PROTOCOL_SIM_RPC_11155111;

describe.skipIf(!RPC_URL)("protocol simulation (sepolia)", () => {
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
