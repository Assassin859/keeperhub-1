/**
 * Out-of-band deploy script for plugins/coalition/contracts/Coalition.sol.
 *
 * Usage:
 *   pnpm tsx scripts/deploy-coalition.ts --network <base-sepolia|base>
 *
 * Required env:
 *   COALITION_DEPLOYER_PK  Hex private key of a funded deployer wallet
 *   RPC_URL                JSON-RPC URL for the target chain
 *
 * Workflow:
 *   1. Compile Coalition.sol locally with solc (one-time):
 *        npx solc --bin --abi --optimize --base-path . --include-path node_modules \
 *          -o /tmp/coalition-out plugins/coalition/contracts/Coalition.sol
 *      Paste the resulting `.bin` content into COALITION_BYTECODE below.
 *   2. Run this script with the env vars set.
 *   3. Paste the printed address into plugins/coalition/contracts/addresses.ts.
 *   4. Verify on Basescan via the printed `forge verify-contract` command.
 *
 * This script is intentionally minimal and standalone: no Hardhat, no Foundry,
 * no deployment manifest. CI does not run it. The contract is documentation-grade
 * source verified on the block explorer post-deploy.
 */
import { ethers } from "ethers";

// Pre-compiled bytecode for Coalition.sol (solc 0.8.24, optimizer 200 runs).
// Regenerate via the solc command in the header above.
const COALITION_BYTECODE = "0x";

const COALITION_ABI_FOR_DEPLOY = ["constructor()"];

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) {
    return;
  }
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const network = parseArg("network");
  if (!network) {
    process.stderr.write(
      "Usage: pnpm tsx scripts/deploy-coalition.ts --network <base-sepolia|base>\n"
    );
    process.exit(1);
  }

  const pk = process.env.COALITION_DEPLOYER_PK;
  const rpcUrl = process.env.RPC_URL;
  if (!(pk && rpcUrl)) {
    process.stderr.write(
      "Missing COALITION_DEPLOYER_PK or RPC_URL env vars.\n"
    );
    process.exit(1);
  }

  if (COALITION_BYTECODE === "0x") {
    process.stderr.write(
      "COALITION_BYTECODE is empty. Compile Coalition.sol with solc and paste the bin output into this script.\n"
    );
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.Wallet(pk, provider);
  process.stdout.write(`Deploying from ${deployer.address} on ${network}...\n`);

  const factory = new ethers.ContractFactory(
    COALITION_ABI_FOR_DEPLOY,
    COALITION_BYTECODE,
    deployer
  );
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const networkInfo = await provider.getNetwork();
  const chainId = Number(networkInfo.chainId);
  const deploymentTx = contract.deploymentTransaction()?.hash ?? "(unknown)";

  process.stdout.write("\nDEPLOYED\n");
  process.stdout.write(`  address:   ${address}\n`);
  process.stdout.write(`  chainId:   ${chainId}\n`);
  process.stdout.write(`  deployTx:  ${deploymentTx}\n`);
  process.stdout.write("\nNext steps:\n");
  process.stdout.write(
    `  1. Paste into plugins/coalition/contracts/addresses.ts:\n`
  );
  process.stdout.write(`       ${chainId}: "${address}",\n`);
  process.stdout.write("  2. Verify on the block explorer:\n");
  process.stdout.write(
    `       forge verify-contract ${address} plugins/coalition/contracts/Coalition.sol:Coalition --chain ${chainId} --watch\n`
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
