/**
 * Tier 1 event-decoding simulations, parameterized per chain.
 *
 * Mirrors chains.test.ts gating: each chain runs only when
 * PROTOCOL_SIM_RPC_<chainId> points at an anvil fork of that chain, so the
 * same env var selects which chains execute. A protocol opts into event
 * simulation on a chain by declaring an `events` block in its
 * testData[chain]; see _shared/simulate-events.ts.
 *
 * Run via: scripts/protocol-local.sh sim [chain]
 */

import { describe } from "vitest";
import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { runEventSimulation } from "./_shared/simulate-events";

const CHAINS = [
  { name: "ethereum", chainId: "1" },
  { name: "sepolia", chainId: "11155111" },
  { name: "base", chainId: "8453" },
] as const;

for (const chain of CHAINS) {
  const rpcUrl = process.env[`PROTOCOL_SIM_RPC_${chain.chainId}`];
  describe.skipIf(!rpcUrl)(`protocol event simulation (${chain.name})`, () => {
    for (const protocol of getRegisteredProtocols()) {
      const chainData = protocol.testData?.[chain.chainId];
      if (!(chainData?.events && protocol.events?.length)) {
        continue;
      }
      describe(protocol.slug, () => {
        runEventSimulation({
          protocol: protocol.slug,
          chainId: chain.chainId,
          rpcUrl: rpcUrl as string,
        });
      });
    }
  });
}
