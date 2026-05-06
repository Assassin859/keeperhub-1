/**
 * Superfluid forwarder address verification.
 *
 * One-shot CLI: confirms CFAv1Forwarder and GDAv1Forwarder are deployed
 * (have non-empty bytecode) at their pinned addresses on every chain
 * Superfluid is shipped on. Run before opening the PR; paste the table
 * output into the PR description.
 *
 * Interpreting failures: a row with a network error (HTTP 401/429/5xx,
 * DNS, timeout) means the public RPC is unreachable -- retry, or update
 * PUBLIC_RPCS in lib/rpc/rpc-config.ts (the single source of truth for
 * chain RPC URLs). A row showing FAIL with no error message means the
 * address actually has empty bytecode on that chain (a real deployment
 * miss to investigate).
 *
 * Usage: pnpm tsx tests/scripts/verify-superfluid-addresses.ts
 */

import { JsonRpcProvider } from "ethers";
import { PUBLIC_RPCS } from "@/lib/rpc/rpc-config";
import {
  CFA_FORWARDER_ADDRESS,
  GDA_FORWARDER_ADDRESS,
  SUPERFLUID_CHAIN_IDS,
} from "@/protocols/superfluid";

type ForwarderName = "CFAv1Forwarder" | "GDAv1Forwarder";

const FORWARDERS: Record<ForwarderName, string> = {
  CFAv1Forwarder: CFA_FORWARDER_ADDRESS,
  GDAv1Forwarder: GDA_FORWARDER_ADDRESS,
};

// Chain ID -> { display name, public RPC URL }. RPCs come from
// lib/rpc/rpc-config.ts so updating the URL in one place benefits every
// caller (seed-chains.ts, the runtime resolver, and this script). Display
// names are local because the lib intentionally only carries URLs.
const CHAIN_META: Record<string, { name: string; rpc: string }> = {
  "1": { name: "Ethereum Mainnet", rpc: PUBLIC_RPCS.ETH_MAINNET },
  "10": { name: "Optimism", rpc: PUBLIC_RPCS.OPTIMISM_MAINNET },
  "137": { name: "Polygon", rpc: PUBLIC_RPCS.POLYGON_MAINNET },
  "8453": { name: "Base", rpc: PUBLIC_RPCS.BASE_MAINNET },
  "42161": { name: "Arbitrum One", rpc: PUBLIC_RPCS.ARBITRUM_MAINNET },
  "11155111": { name: "Sepolia", rpc: PUBLIC_RPCS.SEPOLIA },
};

const CHAINS: { id: number; name: string; rpc: string }[] =
  SUPERFLUID_CHAIN_IDS.map((id) => {
    const meta = CHAIN_META[id];
    return {
      id: Number(id),
      name: meta?.name ?? `Unknown chain ${id}`,
      rpc: meta?.rpc ?? "",
    };
  });

type CheckResult = {
  chainName: string;
  chainId: number;
  forwarder: ForwarderName;
  address: string;
  deployed: boolean;
  error?: string;
};

async function checkOne(
  chain: { id: number; name: string; rpc: string },
  forwarder: ForwarderName
): Promise<CheckResult> {
  const address = FORWARDERS[forwarder];
  try {
    const provider = new JsonRpcProvider(chain.rpc, chain.id);
    const code = await provider.getCode(address);
    return {
      chainName: chain.name,
      chainId: chain.id,
      forwarder,
      address,
      deployed: code !== "0x",
    };
  } catch (error) {
    return {
      chainName: chain.name,
      chainId: chain.id,
      forwarder,
      address,
      deployed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printMarkdownTable(results: CheckResult[]): void {
  console.log("");
  console.log("| Chain | Chain ID | Contract | Address | Status |");
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    const status = r.deployed ? "OK" : `FAIL${r.error ? ` (${r.error})` : ""}`;
    console.log(
      `| ${r.chainName} | ${r.chainId} | ${r.forwarder} | \`${r.address}\` | ${status} |`
    );
  }
  console.log("");
}

async function main(): Promise<void> {
  console.error("Verifying Superfluid forwarder deployments...");

  const tasks: Promise<CheckResult>[] = [];
  for (const chain of CHAINS) {
    for (const fwd of Object.keys(FORWARDERS) as ForwarderName[]) {
      tasks.push(checkOne(chain, fwd));
    }
  }

  const results = await Promise.all(tasks);
  printMarkdownTable(results);

  const failed = results.filter((r) => !r.deployed);
  if (failed.length > 0) {
    console.error(
      `FAILED: ${failed.length} of ${results.length} checks did not find deployed bytecode.`
    );
    process.exit(1);
  }

  console.error(`All ${results.length} forwarder deployments verified.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
