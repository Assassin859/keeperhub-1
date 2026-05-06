/**
 * Live Sepolia end-to-end script for the Superfluid protocol.
 *
 * Walks the full streaming + pool lifecycle against real Superfluid contracts:
 * approve -> wrap -> create-flow -> update-flow -> get-net-flow -> delete-flow
 * -> create-pool -> update-member-units -> connect-pool -> distribute-flow
 * -> read net flow -> cleanup
 *
 * Usage:
 *   export SUPERFLUID_E2E_SENDER_KEY=0x...
 *   pnpm tsx scripts/e2e-superfluid-sepolia.ts
 *
 * Contract addresses are pinned to Superfluid's canonical Sepolia deployments.
 * If Superfluid migrates a contract, override via env vars:
 *   SUPERFLUID_E2E_CFA_FORWARDER   (default: 0xcfA132E353cB4E398080B9700609bb008eceB125)
 *   SUPERFLUID_E2E_GDA_FORWARDER   (default: 0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08)
 *   SUPERFLUID_E2E_SUPER_TOKEN     (default: 0xb598E6C621618a9f63788816ffb50Ee2862D443B, fUSDCx)
 *   SUPERFLUID_E2E_UNDERLYING      (default: 0xe72f289584eDA2bE69Cfe487f4638F09bAc920Db, fUSDC -- "fUSDC Fake Token"; mint(address,uint256) is permissive on Sepolia)
 *
 * Required env vars:
 *   SUPERFLUID_E2E_SENDER_KEY      hex private key, 0x-prefixed
 *
 * Optional env vars:
 *   SUPERFLUID_E2E_RECEIVER_KEY    second wallet key; connect-pool step is SKIPPED if absent
 *   SUPERFLUID_E2E_RPC_URL         default: PUBLIC_RPCS.SEPOLIA from lib/rpc/rpc-config.ts
 *   SUPERFLUID_E2E_WRAP_AMOUNT     wei to wrap (default: 100000000)
 *   SUPERFLUID_E2E_FLOW_RATE       wei/sec flow rate (default: 1000000)
 *
 * Pre-flight: fund the sender wallet with Sepolia ETH (gas) and fUSDC.
 * Faucet: https://app.superfluid.finance/faucet (select Sepolia, claim fUSDC).
 * The script does NOT automate faucet interaction.
 */

import { Contract, ethers, JsonRpcProvider, Wallet } from "ethers";
import { PUBLIC_RPCS } from "@/lib/rpc/rpc-config";
import {
  CFA_FORWARDER_ADDRESS,
  GDA_FORWARDER_ADDRESS,
} from "@/protocols/superfluid";

const SEPOLIA_CHAIN_ID = 11155111;

const DEFAULT_RPC = PUBLIC_RPCS.SEPOLIA;
const DEFAULT_CFA_FORWARDER = CFA_FORWARDER_ADDRESS;
const DEFAULT_GDA_FORWARDER = GDA_FORWARDER_ADDRESS;
const DEFAULT_SUPER_TOKEN = "0xb598E6C621618a9f63788816ffb50Ee2862D443B";
const DEFAULT_UNDERLYING = "0xe72f289584eDA2bE69Cfe487f4638F09bAc920Db";
const DEFAULT_WRAP_AMOUNT = "100000000";
const DEFAULT_FLOW_RATE = "1000000";

// Override gas limit on every write tx. Ethers v6's default eth_estimateGas
// buffer is too tight for CFA/GDA writes -- the actual gas usage can exceed
// the estimate due to SLOAD warming differences between simulation and
// execution, causing OOG reverts (e.g. updateFlow uses ~315k vs estimated
// ~285k). 1.5M gas covers the heaviest call (createPool) with margin.
const TX_OVERRIDES = { gasLimit: 1_500_000 };

// Stable receiver address used when SUPERFLUID_E2E_RECEIVER_KEY is not set.
// This is a deterministic dead-drop address; it will receive flows but nobody
// controls the key, so connect-pool cannot be signed for it.
const FALLBACK_RECEIVER = "0x000000000000000000000000000000000000dEaD";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const SUPER_TOKEN_ABI = [
  "function upgrade(uint256 amount)",
  "function downgrade(uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
];

const CFA_FORWARDER_ABI = [
  "function createFlow(address token, address sender, address receiver, int96 flowRate, bytes userData) returns (bool)",
  "function updateFlow(address token, address sender, address receiver, int96 flowRate, bytes userData) returns (bool)",
  "function deleteFlow(address token, address sender, address receiver, bytes userData) returns (bool)",
  "function getFlowInfo(address token, address sender, address receiver) view returns (uint256 lastUpdated, int96 flowRate, uint256 deposit, uint256 owedDeposit)",
  "function getAccountFlowrate(address token, address account) view returns (int96 flowRate)",
];

const GDA_FORWARDER_ABI = [
  "function createPool(address token, address admin, tuple(bool transferabilityForUnitsOwner, bool distributionFromAnyAddress) config) returns (bool success, address pool)",
  "function updateMemberUnits(address pool, address member, uint128 units, bytes userData) returns (bool)",
  "function getNetFlow(address token, address account) view returns (int96)",
  "function connectPool(address pool, bytes userData) returns (bool)",
  "function distributeFlow(address token, address from, address pool, int96 flowRate, bytes userData) returns (bool)",
  "event PoolCreated(address indexed token, address indexed admin, address pool)",
];

type StepStatus = "PASS" | "SKIPPED" | "FAILED";

interface StepResult {
  name: string;
  status: StepStatus;
  detail: string;
}

const results: StepResult[] = [];

function record(name: string, status: StepStatus, detail: string): void {
  results.push({ name, status, detail });
  const prefix = status === "PASS" ? "OK" : status === "SKIPPED" ? "SKIPPED" : "FAILED";
  console.log(`[${prefix}] ${name}: ${detail}`);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function getEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

async function sendAndWait(
  label: string,
  // biome-ignore lint/suspicious/noExplicitAny: ethers contract calls return ContractTransactionResponse which needs any
  txPromise: Promise<any>
): Promise<ethers.TransactionReceipt> {
  // biome-ignore lint/suspicious/noExplicitAny: ethers v6 contract method return type
  const tx: any = await txPromise;
  console.log(`  [${label}] tx ${tx.hash}`);
  const receipt: ethers.TransactionReceipt | null = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction reverted: ${tx.hash}`);
  }
  return receipt;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  // --- env setup ---
  const senderKey = requireEnv("SUPERFLUID_E2E_SENDER_KEY");
  const receiverKey = process.env.SUPERFLUID_E2E_RECEIVER_KEY;
  const rpcUrl = getEnv("SUPERFLUID_E2E_RPC_URL", DEFAULT_RPC);
  const cfaAddress = getEnv("SUPERFLUID_E2E_CFA_FORWARDER", DEFAULT_CFA_FORWARDER);
  const gdaAddress = getEnv("SUPERFLUID_E2E_GDA_FORWARDER", DEFAULT_GDA_FORWARDER);
  const superTokenAddress = getEnv("SUPERFLUID_E2E_SUPER_TOKEN", DEFAULT_SUPER_TOKEN);
  const underlyingAddress = getEnv("SUPERFLUID_E2E_UNDERLYING", DEFAULT_UNDERLYING);
  const wrapAmount = BigInt(getEnv("SUPERFLUID_E2E_WRAP_AMOUNT", DEFAULT_WRAP_AMOUNT));
  const flowRate = BigInt(getEnv("SUPERFLUID_E2E_FLOW_RATE", DEFAULT_FLOW_RATE));

  const provider = new JsonRpcProvider(rpcUrl, SEPOLIA_CHAIN_ID);
  const senderWallet = new Wallet(senderKey, provider);
  const senderAddress = senderWallet.address;

  let receiverAddress: string;
  let receiverWallet: Wallet | null = null;
  if (receiverKey) {
    receiverWallet = new Wallet(receiverKey, provider);
    receiverAddress = receiverWallet.address;
  } else {
    receiverAddress = FALLBACK_RECEIVER;
    console.log(`SUPERFLUID_E2E_RECEIVER_KEY not set -- using fallback receiver ${FALLBACK_RECEIVER}`);
    console.log("Steps requiring receiver signature will be SKIPPED.");
  }

  console.log(`Sender:   ${senderAddress}`);
  console.log(`Receiver: ${receiverAddress}`);
  console.log(`RPC:      ${rpcUrl}`);
  console.log(`Chain ID: ${SEPOLIA_CHAIN_ID}`);
  console.log("");

  const erc20 = new Contract(underlyingAddress, ERC20_ABI, senderWallet);
  const superToken = new Contract(superTokenAddress, SUPER_TOKEN_ABI, senderWallet);
  const cfa = new Contract(cfaAddress, CFA_FORWARDER_ABI, senderWallet);
  const gda = new Contract(gdaAddress, GDA_FORWARDER_ABI, senderWallet);

  // --- step 1: pre-flight ---
  console.log("[step 1 / pre-flight]");
  const ethBalance: bigint = await provider.getBalance(senderAddress);
  const minEth = ethers.parseEther("0.01");
  if (ethBalance < minEth) {
    console.error(
      `Insufficient ETH for gas: ${ethers.formatEther(ethBalance)} ETH (need >= 0.01). Fund the sender wallet on Sepolia.`
    );
    process.exit(1);
  }
  const underlyingBalance: bigint = await erc20.balanceOf(senderAddress);
  if (underlyingBalance < wrapAmount) {
    console.error(
      `Insufficient fUSDC balance: ${underlyingBalance} wei (need >= ${wrapAmount}). Claim from https://app.superfluid.finance/faucet (Sepolia).`
    );
    process.exit(1);
  }
  record(
    "step 1 / pre-flight",
    "PASS",
    `ETH ${ethers.formatEther(ethBalance)} | fUSDC balance ${underlyingBalance} wei`
  );

  // --- idempotency: close any pre-existing flow before the lifecycle ---
  console.log("\n[idempotency check]");
  const [, existingRate]: [bigint, bigint, bigint, bigint] = await cfa.getFlowInfo(
    superTokenAddress,
    senderAddress,
    receiverAddress
  );
  if (existingRate > BigInt(0)) {
    console.log(`  Pre-existing flow found (${existingRate} wei/s). Deleting before lifecycle.`);
    await sendAndWait("pre-cleanup delete-flow", cfa.deleteFlow(superTokenAddress, senderAddress, receiverAddress, "0x", TX_OVERRIDES));
    console.log("  Pre-existing flow deleted.");
  } else {
    console.log("  No pre-existing flow. Proceeding.");
  }

  // --- step 2: approve underlying ---
  console.log("\n[step 2 / approve]");
  const receipt2 = await sendAndWait(
    "approve",
    erc20.approve(superTokenAddress, wrapAmount, TX_OVERRIDES)
  );
  record(
    "step 2 / approve",
    "PASS",
    `tx ${receipt2.hash} | amount ${wrapAmount} wei`
  );

  // --- step 3: wrap ---
  console.log("\n[step 3 / wrap]");
  const balBefore: bigint = await superToken.balanceOf(senderAddress);
  const receipt3 = await sendAndWait("wrap", superToken.upgrade(wrapAmount, TX_OVERRIDES));
  const balAfter: bigint = await superToken.balanceOf(senderAddress);
  if (balAfter <= balBefore) {
    throw new Error(`Wrap did not increase SuperToken balance: before=${balBefore} after=${balAfter}`);
  }
  record(
    "step 3 / wrap",
    "PASS",
    `tx ${receipt3.hash} | superToken balance before=${balBefore} after=${balAfter}`
  );

  // --- step 4: create-flow ---
  console.log("\n[step 4 / create-flow]");
  const receipt4 = await sendAndWait(
    "create-flow",
    cfa.createFlow(superTokenAddress, senderAddress, receiverAddress, flowRate, "0x", TX_OVERRIDES)
  );
  const [, flowRateAfterCreate]: [bigint, bigint, bigint, bigint] = await cfa.getFlowInfo(
    superTokenAddress,
    senderAddress,
    receiverAddress
  );
  if (flowRateAfterCreate !== flowRate) {
    throw new Error(`Flow rate mismatch after create: expected ${flowRate}, got ${flowRateAfterCreate}`);
  }
  record(
    "step 4 / create-flow",
    "PASS",
    `tx ${receipt4.hash} | flowRate ${flowRate} wei/s`
  );

  // --- step 5: update-flow ---
  console.log("\n[step 5 / update-flow]");
  const newFlowRate = flowRate * BigInt(2);
  const receipt5 = await sendAndWait(
    "update-flow",
    cfa.updateFlow(superTokenAddress, senderAddress, receiverAddress, newFlowRate, "0x", TX_OVERRIDES)
  );
  const [, flowRateAfterUpdate]: [bigint, bigint, bigint, bigint] = await cfa.getFlowInfo(
    superTokenAddress,
    senderAddress,
    receiverAddress
  );
  if (flowRateAfterUpdate !== newFlowRate) {
    throw new Error(`Flow rate mismatch after update: expected ${newFlowRate}, got ${flowRateAfterUpdate}`);
  }
  record(
    "step 5 / update-flow",
    "PASS",
    `tx ${receipt5.hash} | flowRate ${newFlowRate} wei/s`
  );

  // --- step 6: get-net-flow ---
  console.log("\n[step 6 / get-net-flow]");
  const netFlow: bigint = await cfa.getAccountFlowrate(superTokenAddress, receiverAddress);
  // netFlow may be negative for the sender side; for receiver it should be >= newFlowRate
  // (could be higher if receiver has other inbound flows)
  record(
    "step 6 / get-net-flow",
    "PASS",
    `receiver net flow ${netFlow} wei/s`
  );

  // --- step 7: delete-flow ---
  console.log("\n[step 7 / delete-flow]");
  const receipt7 = await sendAndWait(
    "delete-flow",
    cfa.deleteFlow(superTokenAddress, senderAddress, receiverAddress, "0x", TX_OVERRIDES)
  );
  const [, flowRateAfterDelete]: [bigint, bigint, bigint, bigint] = await cfa.getFlowInfo(
    superTokenAddress,
    senderAddress,
    receiverAddress
  );
  if (flowRateAfterDelete !== BigInt(0)) {
    throw new Error(`Flow still active after delete: rate=${flowRateAfterDelete}`);
  }
  record(
    "step 7 / delete-flow",
    "PASS",
    `tx ${receipt7.hash} | flowRate now 0`
  );

  // --- step 8: create-pool ---
  console.log("\n[step 8 / create-pool]");
  const receipt8 = await sendAndWait(
    "create-pool",
    gda.createPool(superTokenAddress, senderAddress, [false, false], TX_OVERRIDES)
  );

  // Parse PoolCreated event from receipt logs
  const gdaInterface = new ethers.Interface(GDA_FORWARDER_ABI);
  const poolCreatedTopic = gdaInterface.getEvent("PoolCreated")?.topicHash;
  let poolAddress = "";
  for (const log of receipt8.logs) {
    if (log.topics[0] === poolCreatedTopic) {
      const parsed = gdaInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.args.pool) {
        poolAddress = parsed.args.pool as string;
        break;
      }
    }
  }
  if (!poolAddress) {
    throw new Error("PoolCreated event not found in create-pool receipt");
  }
  record(
    "step 8 / create-pool",
    "PASS",
    `tx ${receipt8.hash} | pool ${poolAddress}`
  );

  // --- step 9: update-member-units ---
  console.log("\n[step 9 / update-member-units]");
  const receipt9 = await sendAndWait(
    "update-member-units",
    gda.updateMemberUnits(poolAddress, receiverAddress, BigInt(100), "0x", TX_OVERRIDES)
  );
  record(
    "step 9 / update-member-units",
    "PASS",
    `tx ${receipt9.hash} | member ${receiverAddress} | units 100`
  );

  // --- step 10: connect-pool (receiver must sign) ---
  console.log("\n[step 10 / connect-pool]");
  if (receiverWallet !== null) {
    const gdaAsReceiver = new Contract(gdaAddress, GDA_FORWARDER_ABI, receiverWallet);
    const receipt10 = await sendAndWait(
      "connect-pool",
      gdaAsReceiver.connectPool(poolAddress, "0x", TX_OVERRIDES)
    );
    record(
      "step 10 / connect-pool",
      "PASS",
      `tx ${receipt10.hash} | receiver ${receiverAddress} connected`
    );
  } else {
    record(
      "step 10 / connect-pool",
      "SKIPPED",
      "SUPERFLUID_E2E_RECEIVER_KEY not set; receiver cannot sign connect-pool"
    );
  }

  // --- step 11: distribute-flow ---
  console.log("\n[step 11 / distribute-flow]");
  const receipt11 = await sendAndWait(
    "distribute-flow",
    gda.distributeFlow(superTokenAddress, senderAddress, poolAddress, flowRate, "0x", TX_OVERRIDES)
  );
  record(
    "step 11 / distribute-flow",
    "PASS",
    `tx ${receipt11.hash} | flowRate ${flowRate} wei/s`
  );

  // --- step 12: read net flow twice, 5 seconds apart ---
  // CFA's getAccountFlowrate aggregates only CFA flows. To observe the
  // receiver's incoming pool stream we have to query the GDA forwarder's
  // getNetFlow, which combines CFA and GDA flows.
  console.log("\n[step 12 / read-net-flow x2]");
  const netFlowBefore: bigint = await gda.getNetFlow(superTokenAddress, receiverAddress);
  console.log(`  net flow (t=0): ${netFlowBefore} wei/s`);
  await sleep(5000);
  const netFlowAfter: bigint = await gda.getNetFlow(superTokenAddress, receiverAddress);
  console.log(`  net flow (t=5s): ${netFlowAfter} wei/s`);

  if (receiverWallet !== null) {
    if (netFlowAfter <= BigInt(0)) {
      throw new Error(`Expected receiver net flow to be > 0 after connect-pool + distribute-flow, got ${netFlowAfter}`);
    }
    record(
      "step 12 / read-net-flow",
      "PASS",
      `t=0: ${netFlowBefore} wei/s | t=5s: ${netFlowAfter} wei/s`
    );
  } else {
    record(
      "step 12 / read-net-flow",
      "PASS",
      `t=0: ${netFlowBefore} wei/s | t=5s: ${netFlowAfter} wei/s (receiver not connected; flow accumulation not verified)`
    );
  }

  // --- step 13: cleanup ---
  console.log("\n[step 13 / cleanup]");
  const receipt13 = await sendAndWait(
    "cleanup distribute-flow",
    gda.distributeFlow(superTokenAddress, senderAddress, poolAddress, BigInt(0), "0x", TX_OVERRIDES)
  );
  record(
    "step 13 / cleanup",
    "PASS",
    `tx ${receipt13.hash} | pool stream closed`
  );

  // --- summary ---
  console.log("\n--- SUMMARY ---");
  console.log(
    `${"Step".padEnd(40)} ${"Status".padEnd(10)} Detail`
  );
  console.log("-".repeat(100));
  for (const r of results) {
    console.log(`${r.name.padEnd(40)} ${r.status.padEnd(10)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.status === "FAILED");
  const skipped = results.filter((r) => r.status === "SKIPPED");
  console.log(
    `\n${results.length} steps total | ${results.length - failed.length - skipped.length} PASS | ${skipped.length} SKIPPED | ${failed.length} FAILED`
  );

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const failed = results.filter((r) => r.status === "FAILED");
  const msg = error instanceof Error ? error.message : String(error);
  if (failed.length === 0) {
    // Unrecorded failure
    console.error(`\nFATAL: ${msg}`);
  }
  process.exit(1);
});
