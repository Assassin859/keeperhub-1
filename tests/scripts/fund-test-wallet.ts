/**
 * Fund a Sepolia test wallet for live Superfluid demos.
 *
 * Sends Sepolia ETH to a target address and (optionally) mints fUSDC via
 * the permissive Sepolia mint() function on the fake-USDC contract. Used
 * to bootstrap the keeperhub-managed signer wallet before running write
 * workflow fixtures (create-pool, wrap, etc.) against a PR deploy.
 *
 * Usage:
 *   FUNDER_PK=0xabc... \
 *   TARGET=0x42d92e...63ef \
 *   ETH_AMOUNT=0.005 \
 *   FUSDC_AMOUNT=5 \
 *   pnpm tsx tests/scripts/fund-test-wallet.ts
 *
 * Required env:
 *   FUNDER_PK         hex private key, 0x-prefixed (or unprefixed; both are
 *                     accepted). Source it from your secrets manager or a
 *                     gitignored .envrc -- never check it in.
 *   TARGET            recipient address (the workflow wallet -- get it via
 *                     GET /api/user/wallet on the deploy)
 *
 * Optional env:
 *   ETH_AMOUNT        SepETH to send, in ether units (default "0.005")
 *                     Pass "0" to skip the ETH transfer.
 *   FUSDC_AMOUNT      fUSDC to mint, in token units (default "0" = skip)
 *   RPC_URL           Sepolia RPC (default ethereum-sepolia-rpc.publicnode.com)
 *   FUSDC_ADDRESS     override fUSDC address (default 0xe72f...20Db)
 *
 * The fUSDC underlying on Sepolia ships with a permissive
 * mint(address, uint256) -- per the e2e script's documented quirk -- so
 * any caller can drop tokens into any address. Don't assume real USDC
 * behaves like this.
 */

import { ethers } from "ethers";

const HEX_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

const FUNDER_PK = normalizePk(requireEnv("FUNDER_PK"));
const TARGET = requireEnv("TARGET");
const ETH_AMOUNT = process.env.ETH_AMOUNT ?? "0.005";
const FUSDC_AMOUNT = process.env.FUSDC_AMOUNT ?? "0";
const RPC_URL =
  process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const FUSDC_ADDRESS =
  process.env.FUSDC_ADDRESS ?? "0xe72f289584eDA2bE69Cfe487f4638F09bAc920Db";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function normalizePk(raw: string): string {
  const trimmed = raw.trim();
  if (!HEX_KEY_RE.test(trimmed)) {
    console.error(
      "FUNDER_PK must be a 64-character hex string (with or without 0x prefix)"
    );
    process.exit(1);
  }
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

const FUSDC_MINT_ABI = [
  "function mint(address account, uint256 amount)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

async function main(): Promise<void> {
  if (!ethers.isAddress(TARGET)) {
    throw new Error(`Invalid TARGET address: ${TARGET}`);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const funder = new ethers.Wallet(FUNDER_PK, provider);
  console.log(`Funder: ${funder.address}`);
  console.log(`Target: ${TARGET}`);

  const funderEth = await provider.getBalance(funder.address);
  console.log(`Funder SepETH balance: ${ethers.formatEther(funderEth)}`);

  const ethWei = ethers.parseEther(ETH_AMOUNT);
  if (ethWei > 0n) {
    console.log(`\nSending ${ETH_AMOUNT} SepETH...`);
    const tx = await funder.sendTransaction({ to: TARGET, value: ethWei });
    console.log(`  tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  confirmed in block ${receipt?.blockNumber}`);
  } else {
    console.log("\nSkipping SepETH transfer (ETH_AMOUNT=0)");
  }

  const fusdcAmount = Number.parseFloat(FUSDC_AMOUNT);
  if (fusdcAmount > 0) {
    const fUSDC = new ethers.Contract(FUSDC_ADDRESS, FUSDC_MINT_ABI, funder);
    const decimals = (await fUSDC.decimals()) as bigint;
    const amountWei = ethers.parseUnits(FUSDC_AMOUNT, decimals);
    console.log(
      `\nMinting ${FUSDC_AMOUNT} fUSDC (${decimals} decimals = ${amountWei} wei)...`
    );
    const tx = await fUSDC.mint(TARGET, amountWei);
    console.log(`  tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  confirmed in block ${receipt?.blockNumber}`);
    const bal = (await fUSDC.balanceOf(TARGET)) as bigint;
    console.log(
      `  target fUSDC balance now: ${ethers.formatUnits(bal, decimals)}`
    );
  } else {
    console.log("\nSkipping fUSDC mint (FUSDC_AMOUNT=0)");
  }

  const targetEth = await provider.getBalance(TARGET);
  console.log(
    `\nDone. Target SepETH balance: ${ethers.formatEther(targetEth)}`
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
