/**
 * Comprehensive end-to-end test against a live Base Sepolia deployment.
 *
 * What it does:
 *   1. Deploys TestToken (ERC-20 stake) and Coalition.sol from the deployer wallet.
 *   2. Generates 2 ephemeral participant wallets (in addition to the deployer).
 *   3. Funds each participant with native gas + 100 STAKE each from the deployer.
 *   4. Runs the full happy-path lifecycle:
 *        propose -> sign x3 -> activate -> recordBreach(B) -> slash(B) -> dissolve
 *   5. Asserts on every transition: events, balances, state.
 *   6. Runs revert checks: idempotent sign, AlreadySigned replay, non-participant
 *      breach, slash on non-breached party, dissolve by non-participant.
 *   7. Persists the deployed Coalition address into
 *      plugins/coalition/contracts/addresses.ts.
 *
 * No mocks. Every call hits Base Sepolia.
 *
 * Required env:
 *   COALITION_DEPLOYER_PK   Hex private key with Base Sepolia ETH
 *   RPC_URL                 (optional) JSON-RPC URL; defaults to https://sepolia.base.org
 *   COALITION_BUILD_DIR     (optional) Where to find solc-compiled .bin/.abi
 *                           artifacts for Coalition.sol and TestToken.sol.
 *                           Defaults to /tmp/coalition-build.
 *
 * Prerequisite: compile the contracts with solc before running. From repo root:
 *   solc --bin --abi --optimize --base-path . --include-path node_modules \
 *     -o /tmp/coalition-build \
 *     plugins/coalition/contracts/Coalition.sol \
 *     plugins/coalition/contracts/TestToken.sol
 *
 * Run:
 *   node scripts/coalition-e2e.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

// Default to publicnode (multi-region) which is more consistent than the
// public sepolia.base.org load balancer.
const RPC = process.env.RPC_URL || "https://base-sepolia.publicnode.com";
const PK = process.env.COALITION_DEPLOYER_PK;
if (!PK) {
  console.error("Missing COALITION_DEPLOYER_PK env var.");
  process.exit(1);
}

// Resolve paths relative to this script so the e2e runs from any clone.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const ADDRESSES_PATH = resolve(
  REPO_ROOT,
  "plugins/coalition/contracts/addresses.ts"
);

// Build artifacts: regenerate via the solc command in scripts/deploy-coalition.ts.
// Override COALITION_BUILD_DIR if you produce them elsewhere.
const BUILD_DIR = process.env.COALITION_BUILD_DIR || "/tmp/coalition-build";
const COALITION_BIN_PATH = `${BUILD_DIR}/Coalition_sol_Coalition.bin`;
const COALITION_ABI_PATH = `${BUILD_DIR}/Coalition_sol_Coalition.abi`;
const TT_BIN_PATH = `${BUILD_DIR}/TestToken_sol_TestToken.bin`;
const TT_ABI_PATH = `${BUILD_DIR}/TestToken_sol_TestToken.abi`;

// ---- Load ABI + bytecode (use solc JSON output, not the TS const) ----
const COALITION_ABI = JSON.parse(readFileSync(COALITION_ABI_PATH, "utf8"));

const COALITION_BYTECODE = `0x${readFileSync(COALITION_BIN_PATH, "utf8").trim()}`;
const TT_BYTECODE = `0x${readFileSync(TT_BIN_PATH, "utf8").trim()}`;
const TT_ABI = JSON.parse(readFileSync(TT_ABI_PATH, "utf8"));

const provider = new ethers.JsonRpcProvider(RPC);
const deployer = new ethers.Wallet(PK, provider);

// ---- Helpers ----
const log = (msg) => console.log(msg);
const heading = (msg) =>
  console.log(`\n\x1b[1m=== ${msg} ===\x1b[0m`);
const assertEq = (label, actual, expected) => {
  const a = String(actual);
  const e = String(expected);
  if (a !== e) {
    throw new Error(`ASSERT ${label}: got ${a} expected ${e}`);
  }
  log(`  OK  ${label}: ${a}`);
};
// Some RPC nodes serve stale reads after a tx. Retry the read a few times
// before declaring the assertion failed.
const readWithRetry = async (label, readFn, expected, attempts = 8) => {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await readFn();
    if (String(last) === String(expected)) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(
    `ASSERT ${label} after ${attempts} retries: got ${String(last)} expected ${String(expected)}`
  );
};
const assertRevert = async (label, promise, matcher) => {
  try {
    await promise;
    throw new Error(`ASSERT ${label}: expected revert, succeeded instead`);
  } catch (err) {
    const msg = err?.shortMessage || err?.reason || err?.message || String(err);
    if (matcher && !matcher.test(msg)) {
      throw new Error(`ASSERT ${label}: revert reason mismatch: ${msg}`);
    }
    log(`  OK  ${label} reverted (${matcher?.source ?? "any"})`);
  }
};

async function main() {
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== 84532) {
    throw new Error(`Expected Base Sepolia (84532), got ${chainId}`);
  }
  heading(`Connected to Base Sepolia, deployer=${deployer.address}`);
  const startBal = await provider.getBalance(deployer.address);
  log(`Deployer balance: ${ethers.formatEther(startBal)} ETH`);

  // ---- 1. Deploy TestToken ----
  heading("1. Deploy TestToken");
  const ttFactory = new ethers.ContractFactory(TT_ABI, TT_BYTECODE, deployer);
  const tt = await ttFactory.deploy();
  const ttDeployTx = tt.deploymentTransaction();
  log(`  deploy tx: ${ttDeployTx?.hash}`);
  await tt.waitForDeployment();
  const ttAddr = await tt.getAddress();
  log(`  TestToken: ${ttAddr}`);

  // ---- 2. Deploy Coalition ----
  heading("2. Deploy Coalition");
  const coalitionFactory = new ethers.ContractFactory(
    COALITION_ABI,
    COALITION_BYTECODE,
    deployer
  );
  const coalition = await coalitionFactory.deploy();
  const cDeployTx = coalition.deploymentTransaction();
  log(`  deploy tx: ${cDeployTx?.hash}`);
  await coalition.waitForDeployment();
  const coalitionAddr = await coalition.getAddress();
  log(`  Coalition: ${coalitionAddr}`);

  // Persist address to addresses.ts so the plugin can reference it.
  const addressesContent = readFileSync(ADDRESSES_PATH, "utf8");
  const updated = addressesContent.replace(
    /export const COALITION_ADDRESSES: Record<number, `0x\$\{string\}`> = \{[^}]*\};/,
    `export const COALITION_ADDRESSES: Record<number, \`0x\${string}\`> = {\n  84532: "${coalitionAddr}", // Base Sepolia\n};`
  );
  writeFileSync(ADDRESSES_PATH, updated, "utf8");
  log(`  Wrote addresses.ts: 84532 -> ${coalitionAddr}`);

  // ---- 3. Generate participants ----
  heading("3. Generate ephemeral participants B and C");
  const partyA = deployer; // deployer is also participant A
  const partyB = ethers.Wallet.createRandom().connect(provider);
  const partyC = ethers.Wallet.createRandom().connect(provider);
  log(`  A (deployer): ${partyA.address}`);
  log(`  B:            ${partyB.address}`);
  log(`  C:            ${partyC.address}`);

  // ---- 4. Fund participants ----
  heading("4. Fund participants (gas + 100 stake each)");
  const STAKE_PER_PARTY = ethers.parseUnits("10", 18); // 10 STAKE per coalition signing
  const ETH_FOR_GAS = ethers.parseEther("0.01"); // 0.01 ETH each for gas
  const STAKE_MINT = ethers.parseUnits("100", 18); // 100 STAKE per participant

  const fundB1 = await partyA.sendTransaction({
    to: partyB.address,
    value: ETH_FOR_GAS,
  });
  log(`  -> B gas tx: ${fundB1.hash}`);
  await fundB1.wait();
  const fundC1 = await partyA.sendTransaction({
    to: partyC.address,
    value: ETH_FOR_GAS,
  });
  log(`  -> C gas tx: ${fundC1.hash}`);
  await fundC1.wait();

  const ttA = new ethers.Contract(ttAddr, TT_ABI, partyA);
  const mintATx = await ttA.mint(partyA.address, STAKE_MINT);
  log(`  -> mint A tx: ${mintATx.hash}`);
  await mintATx.wait();
  const mintBTx = await ttA.mint(partyB.address, STAKE_MINT);
  log(`  -> mint B tx: ${mintBTx.hash}`);
  await mintBTx.wait();
  const mintCTx = await ttA.mint(partyC.address, STAKE_MINT);
  log(`  -> mint C tx: ${mintCTx.hash}`);
  // Confirm with extra safety: getTransactionReceipt on the same provider.
  await mintCTx.wait(1);
  // Belt-and-suspenders: re-poll until the receipt is canonical.
  for (let i = 0; i < 5; i++) {
    const r = await provider.getTransactionReceipt(mintCTx.hash);
    if (r && r.status === 1) {
      break;
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  assertEq("A balance after mint", await ttA.balanceOf(partyA.address), STAKE_MINT);
  assertEq("B balance after mint", await ttA.balanceOf(partyB.address), STAKE_MINT);
  assertEq("C balance after mint", await ttA.balanceOf(partyC.address), STAKE_MINT);

  // ---- 5. Propose ----
  heading("5. Propose coalition (deadline = +1 hour)");
  const cA = new ethers.Contract(coalitionAddr, COALITION_ABI, partyA);
  const cB = new ethers.Contract(coalitionAddr, COALITION_ABI, partyB);
  const cC = new ethers.Contract(coalitionAddr, COALITION_ABI, partyC);

  const termsHash = ethers.keccak256(ethers.toUtf8Bytes("E2E Coalition Terms"));
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const proposeTx = await cA.propose(
    [partyA.address, partyB.address, partyC.address],
    termsHash,
    deadline,
    ttAddr,
    STAKE_PER_PARTY
  );
  log(`  propose tx: ${proposeTx.hash}`);
  const proposeReceipt = await proposeTx.wait();
  // Parse the Proposed event to get coalitionId
  const iface = new ethers.Interface(COALITION_ABI);
  let coalitionId;
  for (const log_ of proposeReceipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log_.topics], data: log_.data });
      if (parsed?.name === "Proposed") {
        coalitionId = parsed.args.id;
      }
    } catch {
      /* not a coalition event */
    }
  }
  if (coalitionId === undefined) {
    throw new Error("Proposed event not found in receipt");
  }
  assertEq("coalitionId", coalitionId, 1n);

  // Read state (retry tolerant — public RPC nodes have eventual consistency)
  await readWithRetry(
    "state after propose (PROPOSED=1)",
    async () => (await cA.getCoalition(coalitionId)).state,
    1
  );
  const stateAfterPropose = await cA.getCoalition(coalitionId);
  assertEq("participants count", stateAfterPropose.participants.length, 3);
  assertEq("signedCount", stateAfterPropose.signedCount, 0);

  // ---- 6. Revert checks on propose ----
  heading("6. Revert checks on propose");
  await assertRevert(
    "  propose with 1 participant",
    cA.propose([partyA.address], termsHash, deadline, ttAddr, STAKE_PER_PARTY),
    /InvalidParticipantCount|execution reverted/
  );
  await assertRevert(
    "  propose with past deadline",
    cA.propose(
      [partyA.address, partyB.address],
      termsHash,
      Math.floor(Date.now() / 1000) - 100,
      ttAddr,
      STAKE_PER_PARTY
    ),
    /DeadlineInPast|execution reverted/
  );
  await assertRevert(
    "  propose with zero stake",
    cA.propose(
      [partyA.address, partyB.address],
      termsHash,
      deadline,
      ttAddr,
      0
    ),
    /ZeroStake|execution reverted/
  );

  // ---- 7. Sign x3 with allowance ----
  heading("7. Sign x3 (each party approves + signs)");
  for (const [label, party, c] of [
    ["A", partyA, cA],
    ["B", partyB, cB],
    ["C", partyC, cC],
  ]) {
    const tt_ = new ethers.Contract(ttAddr, TT_ABI, party);
    const apTx = await tt_.approve(coalitionAddr, STAKE_PER_PARTY);
    await apTx.wait();
    const signTx = await c.sign(coalitionId);
    log(`  ${label} sign tx: ${signTx.hash}`);
    await signTx.wait();
    await readWithRetry(
      `  isSigned[${label}]`,
      async () => await c.isSigned(coalitionId, party.address),
      true
    );
  }

  await readWithRetry(
    "signedCount after all signs",
    async () => (await cA.getCoalition(coalitionId)).signedCount,
    3
  );

  // Idempotency / replay: signing again must revert
  await assertRevert(
    "  sign(A) twice -> AlreadySigned",
    cA.sign(coalitionId),
    /AlreadySigned|execution reverted/
  );

  // Non-participant cannot sign
  const stranger = ethers.Wallet.createRandom().connect(provider);
  // Fund stranger with enough gas for the call; sign will revert on NotParticipant first
  await (
    await partyA.sendTransaction({ to: stranger.address, value: ethers.parseEther("0.001") })
  ).wait();
  await (
    await new ethers.Contract(ttAddr, TT_ABI, stranger).approve(
      coalitionAddr,
      STAKE_PER_PARTY
    )
  ).wait();
  // Note: stranger has no STAKE tokens minted; the contract reverts on NotParticipant before transfer.
  const cStranger = new ethers.Contract(coalitionAddr, COALITION_ABI, stranger);
  await assertRevert(
    "  stranger sign -> NotParticipant",
    cStranger.sign(coalitionId),
    /NotParticipant|execution reverted/
  );

  // ---- 8. Activate ----
  heading("8. Activate");
  const activateTx = await cA.activate(coalitionId);
  log(`  activate tx: ${activateTx.hash}`);
  await activateTx.wait();
  await readWithRetry(
    "state after activate (ACTIVE=2)",
    async () => (await cA.getCoalition(coalitionId)).state,
    2
  );

  await assertRevert(
    "  activate twice -> CoalitionNotProposed",
    cA.activate(coalitionId),
    /CoalitionNotProposed|execution reverted/
  );

  // ---- 9. Breach pre-checks ----
  heading("9. Breach pre-check reverts");
  const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("E2E breach evidence"));
  await assertRevert(
    "  recordBreach for non-participant",
    cA.recordBreach(coalitionId, stranger.address, evidenceHash),
    /NotParticipant|execution reverted/
  );

  // ---- 10. Record breach on B ----
  heading("10. Record breach on B");
  const breachTx = await cA.recordBreach(coalitionId, partyB.address, evidenceHash);
  log(`  breach tx: ${breachTx.hash}`);
  await breachTx.wait();
  await readWithRetry(
    "isBreached[B]",
    async () => await cA.isBreached(coalitionId, partyB.address),
    true
  );
  await assertRevert(
    "  recordBreach(B) twice -> PartyAlreadyBreached",
    cA.recordBreach(coalitionId, partyB.address, evidenceHash),
    /PartyAlreadyBreached|execution reverted/
  );

  // ---- 11. Slash pre-checks + execute ----
  heading("11. Slash B");
  await assertRevert(
    "  slash(C) before breach -> PartyNotBreached",
    cA.slash(coalitionId, partyC.address),
    /PartyNotBreached|execution reverted/
  );

  const balsBefore = {
    A: await tt.balanceOf(partyA.address),
    B: await tt.balanceOf(partyB.address),
    C: await tt.balanceOf(partyC.address),
    contract: await tt.balanceOf(coalitionAddr),
  };
  log(
    `  balances before slash: A=${ethers.formatUnits(balsBefore.A, 18)} B=${ethers.formatUnits(balsBefore.B, 18)} C=${ethers.formatUnits(balsBefore.C, 18)} contract=${ethers.formatUnits(balsBefore.contract, 18)}`
  );

  const slashTx = await cA.slash(coalitionId, partyB.address);
  log(`  slash tx: ${slashTx.hash}`);
  const slashReceipt = await slashTx.wait();
  // Parse Slashed event for amountRedistributed
  let amountRedistributed;
  for (const log_ of slashReceipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log_.topics], data: log_.data });
      if (parsed?.name === "Slashed") {
        amountRedistributed = parsed.args.amountRedistributed;
      }
    } catch {
      /* not a coalition event */
    }
  }
  // STAKE_PER_PARTY = 10, recipients (A, C) = 2, share = 5, amountRedistributed = 5*2 = 10
  assertEq("amountRedistributed", amountRedistributed, STAKE_PER_PARTY);
  await readWithRetry(
    "isSlashed[B]",
    async () => await cA.isSlashed(coalitionId, partyB.address),
    true
  );

  const balsAfterSlash = {
    A: await tt.balanceOf(partyA.address),
    B: await tt.balanceOf(partyB.address),
    C: await tt.balanceOf(partyC.address),
    contract: await tt.balanceOf(coalitionAddr),
  };
  log(
    `  balances after slash:  A=${ethers.formatUnits(balsAfterSlash.A, 18)} B=${ethers.formatUnits(balsAfterSlash.B, 18)} C=${ethers.formatUnits(balsAfterSlash.C, 18)} contract=${ethers.formatUnits(balsAfterSlash.contract, 18)}`
  );
  // A and C each gain stake/2 = 5
  const expectedShare = STAKE_PER_PARTY / 2n;
  assertEq("A delta", balsAfterSlash.A - balsBefore.A, expectedShare);
  assertEq("C delta", balsAfterSlash.C - balsBefore.C, expectedShare);
  assertEq("B delta (no change)", balsAfterSlash.B - balsBefore.B, 0n);

  await assertRevert(
    "  slash(B) twice -> PartyAlreadySlashed",
    cA.slash(coalitionId, partyB.address),
    /PartyAlreadySlashed|execution reverted/
  );

  // ---- 12. Dissolve auth checks + execute ----
  heading("12. Dissolve");
  await assertRevert(
    "  dissolve by stranger -> NotParticipant",
    cStranger.dissolve(coalitionId),
    /NotParticipant|execution reverted/
  );

  const dissolveTx = await cA.dissolve(coalitionId);
  log(`  dissolve tx: ${dissolveTx.hash}`);
  await dissolveTx.wait();
  await readWithRetry(
    "state after dissolve (DISSOLVED=3)",
    async () => (await cA.getCoalition(coalitionId)).state,
    3
  );

  const balsAfterDissolve = {
    A: await tt.balanceOf(partyA.address),
    B: await tt.balanceOf(partyB.address),
    C: await tt.balanceOf(partyC.address),
    contract: await tt.balanceOf(coalitionAddr),
  };
  log(
    `  balances after dissolve: A=${ethers.formatUnits(balsAfterDissolve.A, 18)} B=${ethers.formatUnits(balsAfterDissolve.B, 18)} C=${ethers.formatUnits(balsAfterDissolve.C, 18)} contract=${ethers.formatUnits(balsAfterDissolve.contract, 18)}`
  );
  // A and C should each receive stakePerParty back
  assertEq("A refund", balsAfterDissolve.A - balsAfterSlash.A, STAKE_PER_PARTY);
  assertEq("C refund", balsAfterDissolve.C - balsAfterSlash.C, STAKE_PER_PARTY);
  // B (slashed/breached) gets nothing
  assertEq("B refund (none)", balsAfterDissolve.B - balsAfterSlash.B, 0n);
  // Contract balance is 0 after dissolve (10 originally minted on B's stake fully redistributed in slash)
  assertEq("Contract empty", balsAfterDissolve.contract, 0n);

  // ---- 13. Final summary ----
  heading("13. SUCCESS - all 30+ assertions passed");
  log(`Coalition deployed at:    ${coalitionAddr}`);
  log(`TestToken deployed at:    ${ttAddr}`);
  log(`addresses.ts updated for chainId 84532.`);
  log(`Basescan link:            https://sepolia.basescan.org/address/${coalitionAddr}`);
  log(`Propose tx:               https://sepolia.basescan.org/tx/${proposeTx.hash}`);
  log(`Slash tx:                 https://sepolia.basescan.org/tx/${slashTx.hash}`);
  log(`Dissolve tx:              https://sepolia.basescan.org/tx/${dissolveTx.hash}`);

  const endBal = await provider.getBalance(deployer.address);
  log(`Deployer ETH spent:       ${ethers.formatEther(startBal - endBal)} ETH`);
}

main().catch((err) => {
  console.error("\n\x1b[31mFAILED\x1b[0m");
  console.error(err);
  process.exit(1);
});
