/**
 * Tier 1 simulations, parameterized per chain.
 *
 * Each chain gates on PROTOCOL_SIM_RPC_<chainId> pointing at an anvil fork
 * of that chain and skips cleanly when absent (CI without the fork, local
 * without the rig), so one env var selects exactly which chains run.
 * Run via: scripts/protocol-local.sh sim [chain]
 */

import { describe } from "vitest";
import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { runSimulation } from "./_shared/simulate";

const CHAINS = [
  { name: "ethereum", chainId: "1" },
  { name: "sepolia", chainId: "11155111" },
  { name: "base", chainId: "8453" },
] as const;

for (const chain of CHAINS) {
  const rpcUrl = process.env[`PROTOCOL_SIM_RPC_${chain.chainId}`];
  describe.skipIf(!rpcUrl)(`protocol simulation (${chain.name})`, () => {
    for (const protocol of getRegisteredProtocols()) {
      if (!protocol.testData?.[chain.chainId]) {
        continue;
      }
      describe(protocol.slug, () => {
        runSimulation({
          protocol: protocol.slug,
          chainId: chain.chainId,
          rpcUrl: rpcUrl as string,
        });
      });
    }
  });
}
