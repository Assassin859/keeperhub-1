/**
 * Sets up a Solana devnet fixture for exercising the Transfer SPL Token action
 * end to end: funds the organization wallet with devnet SOL, creates a fresh SPL
 * mint, and mints a starting balance into the wallet's associated token account.
 *
 * The transfer itself runs through the app (the organization wallet is signed by
 * Turnkey, not by a local key), so this script only arranges the on-chain state
 * and prints the mint address to paste into the workflow node.
 *
 * A locally generated payer keypair funds and owns the mint. It is devnet-only
 * and holds no real value; it is cached so repeat runs reuse the same mint
 * authority rather than re-airdropping.
 *
 * Usage:
 *   npx tsx scripts/solana-devnet-spl-fixture.ts <org-solana-address>
 *   npx tsx scripts/solana-devnet-spl-fixture.ts <org-solana-address> --decimals 6 --amount 1000
 *   npx tsx scripts/solana-devnet-spl-fixture.ts <org-solana-address> --mint <existing-mint>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";

const DEVNET_RPC = process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";
const PAYER_KEY_PATH = join(process.cwd(), ".claude", ".solana-devnet-payer.json");

// Devnet faucet ceiling per request; airdrops above this are rejected outright.
const MAX_AIRDROP_SOL = 2;
// Enough for the mint account, the ATAs, and transaction fees.
const PAYER_TARGET_SOL = 2;
// The org wallet only pays fees plus rent for a recipient ATA (~0.002 SOL).
const ORG_TARGET_SOL = 0.5;

type Args = {
  orgAddress: string;
  decimals: number;
  amount: number;
  existingMint?: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  const orgAddress = positional[0];

  if (!orgAddress) {
    console.error(
      "Usage: npx tsx scripts/solana-devnet-spl-fixture.ts <org-solana-address> [--decimals 6] [--amount 1000] [--mint <address>]"
    );
    console.error(
      "\nThe org Solana address is shown in the wallet overlay, or:\n" +
        "  psql -c \"select solana_address from organization_wallets where organization_id = '<id>'\""
    );
    process.exit(1);
  }

  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  return {
    orgAddress,
    decimals: Number(flag("decimals") ?? 6),
    amount: Number(flag("amount") ?? 1000),
    existingMint: flag("mint"),
  };
}

/** Loads the cached devnet payer, generating one on first run. */
function loadPayer(): Keypair {
  if (existsSync(PAYER_KEY_PATH)) {
    const secret = JSON.parse(readFileSync(PAYER_KEY_PATH, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }

  const payer = Keypair.generate();
  mkdirSync(dirname(PAYER_KEY_PATH), { recursive: true });
  writeFileSync(PAYER_KEY_PATH, JSON.stringify(Array.from(payer.secretKey)));
  console.log(`Generated a devnet payer at ${PAYER_KEY_PATH}`);
  return payer;
}

/** Tops an account up to `targetSol`, tolerating a rate-limited faucet. */
async function ensureFunded(
  connection: Connection,
  address: PublicKey,
  targetSol: number,
  label: string
): Promise<void> {
  const balance = await connection.getBalance(address);
  const targetLamports = targetSol * LAMPORTS_PER_SOL;

  if (balance >= targetLamports) {
    console.log(`${label} has ${balance / LAMPORTS_PER_SOL} SOL - no airdrop needed`);
    return;
  }

  const wanted = Math.min(targetSol, MAX_AIRDROP_SOL) * LAMPORTS_PER_SOL;
  console.log(`Airdropping ${wanted / LAMPORTS_PER_SOL} SOL to ${label}...`);

  try {
    const signature = await connection.requestAirdrop(address, wanted);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
      { signature, ...latest },
      "confirmed"
    );
    const updated = await connection.getBalance(address);
    console.log(`${label} now has ${updated / LAMPORTS_PER_SOL} SOL`);
  } catch (error) {
    // The public devnet faucet rate-limits aggressively. A funded-enough account
    // is fine; an empty one is not.
    const current = await connection.getBalance(address);
    if (current === 0) {
      console.error(
        `Airdrop failed and ${label} has no SOL: ${error instanceof Error ? error.message : String(error)}\n` +
          "The devnet faucet is rate-limited. Use https://faucet.solana.com or retry later."
      );
      process.exit(1);
    }
    console.log(
      `Airdrop failed but ${label} already holds ${current / LAMPORTS_PER_SOL} SOL - continuing`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  let orgPk: PublicKey;
  try {
    orgPk = new PublicKey(args.orgAddress);
  } catch {
    console.error(`Not a valid Solana address: ${args.orgAddress}`);
    process.exit(1);
  }

  const connection = new Connection(DEVNET_RPC, "confirmed");
  const payer = loadPayer();

  console.log(`RPC:    ${DEVNET_RPC}`);
  console.log(`Payer:  ${payer.publicKey.toBase58()}`);
  console.log(`Org:    ${orgPk.toBase58()}\n`);

  await ensureFunded(connection, payer.publicKey, PAYER_TARGET_SOL, "payer");
  // The org wallet pays its own transfer fee and any recipient-ATA rent.
  await ensureFunded(connection, orgPk, ORG_TARGET_SOL, "org wallet");

  const mint = args.existingMint
    ? new PublicKey(args.existingMint)
    : await createMint(
        connection,
        payer,
        payer.publicKey, // mint authority
        null, // no freeze authority: a frozen mint cannot be transferred
        args.decimals,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );

  console.log(`\nMint:   ${mint.toBase58()}${args.existingMint ? " (existing)" : " (created)"}`);

  const orgAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer, // the payer funds the org's ATA rent, not the org
    mint,
    orgPk,
    true, // allowOwnerOffCurve: the org wallet may be program-owned
    "confirmed",
    undefined,
    TOKEN_PROGRAM_ID
  );

  const raw = BigInt(Math.round(args.amount * 10 ** args.decimals));
  await mintTo(
    connection,
    payer,
    mint,
    orgAta.address,
    payer,
    raw,
    [],
    undefined,
    TOKEN_PROGRAM_ID
  );

  const balance = await connection.getTokenAccountBalance(orgAta.address);

  console.log(`Org ATA: ${orgAta.address.toBase58()}`);
  console.log(`Balance: ${balance.value.uiAmountString} (${args.decimals} decimals)`);
  console.log("\nReady. In the workflow builder:");
  console.log("  1. Add a Transfer SPL Token node");
  console.log("  2. Network:        Solana Devnet");
  console.log(`  3. Token Mint:     ${mint.toBase58()}`);
  console.log("  4. Amount:         1");
  console.log(`  5. Recipient:      ${Keypair.generate().publicKey.toBase58()}  (a fresh key - exercises recipient-ATA creation)`);
  console.log(`\nInspect: https://solscan.io/token/${mint.toBase58()}?cluster=devnet`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
