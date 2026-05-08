/**
 * Pins data/agent-registry.json to Pinata and reports the resulting IPFS CID.
 *
 * Compares the new CID against the on-chain agentURI (read via tokenURI on the
 * ERC-8004 Identity Registry). If they differ, prints the manual command to
 * submit the on-chain update tx. The script never sends a transaction itself --
 * the owner private key stays out of CI.
 *
 * Required env:
 *   PINATA_JWT - Pinata API JWT (https://app.pinata.cloud/developers/api-keys)
 *
 * Optional env:
 *   AGENT_ID                       - default 31875
 *   IDENTITY_REGISTRY_ADDRESS      - default 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 *   CHAIN_ETH_MAINNET_PRIMARY_RPC  - default https://chain.techops.services/eth-mainnet
 *
 * Run: pnpm tsx scripts/pin-agent-card.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";

const DEFAULT_AGENT_ID = "31875";
const DEFAULT_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const DEFAULT_RPC = "https://chain.techops.services/eth-mainnet";
const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const CARD_PATH = join(process.cwd(), "data/agent-registry.json");

const TOKEN_URI_ABI = [
  {
    inputs: [{ name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

type PinataResponse = {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
};

async function pinToPinata(jwt: string, bytes: Buffer): Promise<PinataResponse> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/json" });
  form.append("file", blob, "agent-registry.json");
  form.append(
    "pinataMetadata",
    JSON.stringify({ name: "keeperhub-agent-registry" })
  );
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const resp = await fetch(PINATA_PIN_FILE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Pinata pin failed: ${resp.status} ${resp.statusText} -- ${body}`);
  }

  return (await resp.json()) as PinataResponse;
}

async function readOnchainAgentURI(
  rpcUrl: string,
  registry: string,
  agentId: string
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(
    registry,
    TOKEN_URI_ABI as unknown as ethers.InterfaceAbi,
    provider
  );
  const result = (await contract.tokenURI(agentId)) as string;
  return result;
}

export async function pinAgentCard(): Promise<void> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error("PINATA_JWT environment variable is required");
  }

  const agentId = process.env.AGENT_ID ?? DEFAULT_AGENT_ID;
  const registry = process.env.IDENTITY_REGISTRY_ADDRESS ?? DEFAULT_REGISTRY;
  const rpcUrl = process.env.CHAIN_ETH_MAINNET_PRIMARY_RPC ?? DEFAULT_RPC;

  const bytes = readFileSync(CARD_PATH);
  console.log(`[pin] Pinning ${CARD_PATH} (${bytes.length} bytes) to Pinata...`);

  const pinned = await pinToPinata(jwt, bytes);
  const newUri = `ipfs://${pinned.IpfsHash}`;
  console.log(`[pin] Pinned: ${newUri}`);
  console.log(`[pin] Gateway: https://gateway.pinata.cloud/ipfs/${pinned.IpfsHash}`);

  const currentUri = await readOnchainAgentURI(rpcUrl, registry, agentId);
  console.log(`[pin] On-chain agentURI for agent ${agentId}: ${currentUri}`);

  if (currentUri === newUri) {
    console.log("[pin] No drift -- on-chain agentURI already matches the pinned CID.");
    return;
  }

  console.log("[pin] DRIFT DETECTED. To update the on-chain agentURI, run locally:");
  console.log("");
  console.log(`  REGISTRATION_PRIVATE_KEY=<owner-key> NEW_AGENT_URI="${newUri}" \\`);
  console.log("    pnpm tsx scripts/update-agent-uri.ts");
  console.log("");
  console.log(
    "[pin] (The pinned content is durable on Pinata; the on-chain pointer just hasn't been updated yet.)"
  );
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("pin-agent-card.ts") ||
    process.argv[1].endsWith("pin-agent-card.js"));

if (isMain) {
  pinAgentCard().catch((err) => {
    console.error("[pin] Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
