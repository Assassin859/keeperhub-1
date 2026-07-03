/**
 * Tier 1 fork simulation harness.
 *
 * Runs every registry action for a (protocol, chain) directly against an
 * anvil fork - no app, no webhook, no Turnkey. Impersonation replaces
 * signing and direct RPC replaces the executor, but the semantics mirror
 * the e2e coverage suites exactly: testData setup (native gas, ERC20s,
 * approvals, protocol steps) provisions state first, reads are eth_call
 * with decoded outputs asserted through the same output oracle, and
 * writes are real impersonated transactions in registry order so later
 * writes see earlier writes' state (borrow needs supply, repay needs
 * borrow).
 *
 * What a green Tier 1 run proves: the action's encoding and its
 * semantics against the real (forked) protocol contracts. What it does
 * not prove: the platform's webhook/executor/signing path - that is
 * Tier 2's job, which only needs representatives because that path is
 * shared by all actions.
 *
 * Skips follow testData.skipped with the same reasons as the e2e suites.
 */

import { Contract, type Interface, JsonRpcProvider, parseUnits } from "ethers";
import { expect, test } from "vitest";
import { getProtocol } from "@/lib/protocol-registry";
import { resolveBinding } from "@/lib/test-data/build-workflow";
import {
  FAUCETS,
  FORK_WHALES,
  TOKEN_REGISTRY,
  type TokenSymbol,
} from "@/lib/test-data/chain-test-data";
import {
  type EncodedAction,
  encodeBoundAction,
  encodeSetupSteps,
} from "@/lib/test-data/encode-action";
import { structureAbiOutputs } from "@/plugins/web3/steps/structure-abi-result";
import {
  type AbiFunction,
  bindFaucetArgs,
} from "../../protocol-coverage/_shared/funding";
import { checkOutputExpectation } from "../../protocol-coverage/_shared/oracle";
import { planPhaseFixtures } from "../../protocol-coverage/_shared/plan";

/** Fixed simulation wallet: any address works under impersonation; fixed
 *  keeps behavior reproducible across runs. Distinct from anvil's dev
 *  accounts to avoid colliding with their pre-existing nonces/balances. */
export const SIM_WALLET = "0x5115000000000000000000000000000000000051";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const WRITE_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 30_000;

async function impersonatedSend(
  provider: JsonRpcProvider,
  from: string,
  tx: { to: string; data?: string; value?: bigint }
): Promise<void> {
  await provider.send("anvil_impersonateAccount", [from]);
  try {
    const signer = await provider.getSigner(from);
    const sent = await signer.sendTransaction(tx);
    const receipt = await sent.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`impersonated tx to ${tx.to} reverted`);
    }
  } finally {
    await provider.send("anvil_stopImpersonatingAccount", [from]);
  }
}

async function ensureErc20(
  provider: JsonRpcProvider,
  chainId: string,
  symbol: TokenSymbol,
  human: string
): Promise<void> {
  const entry = TOKEN_REGISTRY[chainId]?.[symbol];
  if (!entry) {
    throw new Error(`TOKEN_REGISTRY missing ${symbol} on chain ${chainId}`);
  }
  const token = new Contract(entry.address, ERC20_ABI, provider);
  const needed = parseUnits(human, entry.decimals);
  const balance: bigint = await token.balanceOf(SIM_WALLET);
  if (balance >= needed) {
    return;
  }
  const gap = needed - balance;

  const whale = FORK_WHALES[chainId]?.[symbol];
  if (whale) {
    // Whales are chosen for token balance, not ETH; fund their gas.
    await provider.send("anvil_setBalance", [
      whale.address,
      "0x8ac7230489e80000",
    ]);
    const iface = token.interface;
    await impersonatedSend(provider, whale.address, {
      to: entry.address,
      data: iface.encodeFunctionData("transfer", [SIM_WALLET, gap]),
    });
    return;
  }
  const faucet = FAUCETS[chainId]?.[symbol];
  if (faucet) {
    const abi = JSON.parse(faucet.abi) as AbiFunction[];
    const fn = abi.find((f) => f.name === faucet.functionName);
    if (!fn) {
      throw new Error(`faucet ABI missing ${faucet.functionName}`);
    }
    const args = bindFaucetArgs(fn, entry.address, SIM_WALLET, gap);
    const faucetContract = new Contract(faucet.contract, abi, provider);
    await impersonatedSend(provider, SIM_WALLET, {
      to: faucet.contract,
      data: faucetContract.interface.encodeFunctionData(
        faucet.functionName,
        args
      ),
    });
    return;
  }
  throw new Error(
    `no whale or faucet for ${symbol} on chain ${chainId}; cannot provision`
  );
}

async function provisionSetup(
  provider: JsonRpcProvider,
  protocolSlug: string,
  chainId: string
): Promise<void> {
  const protocol = getProtocol(protocolSlug);
  const setup = protocol?.testData?.[chainId]?.setup;
  if (!(protocol && setup)) {
    throw new Error(`no setup spec for ${protocolSlug} on ${chainId}`);
  }

  // 10 ETH native gas via cheatcode.
  await provider.send("anvil_setBalance", [SIM_WALLET, "0x8ac7230489e80000"]);

  for (const required of setup.requiredTokens) {
    await ensureErc20(provider, chainId, required.symbol, required.human);
  }

  for (const approval of setup.approvals) {
    const entry = TOKEN_REGISTRY[chainId]?.[approval.token];
    if (!entry) {
      throw new Error(`TOKEN_REGISTRY missing ${approval.token}`);
    }
    // Same resolver the builder uses for approval.spender, including its
    // throw on a missing contract address (an empty spender would encode
    // approve(0x0) and revert opaquely downstream).
    const spender = resolveBinding(
      approval.spender,
      "address",
      protocol,
      chainId,
      SIM_WALLET
    );
    const token = new Contract(entry.address, ERC20_ABI, provider);
    await impersonatedSend(provider, SIM_WALLET, {
      to: entry.address,
      data: token.interface.encodeFunctionData("approve", [
        spender,
        parseUnits(approval.human, entry.decimals),
      ]),
    });
  }

  // Setup steps encode from the setup workflow's own node configs (their
  // inputs differ from the action fixtures), impersonated in order.
  for (const step of encodeSetupSteps(protocolSlug, chainId, SIM_WALLET)) {
    await impersonatedSend(provider, SIM_WALLET, {
      to: step.to,
      data: step.data,
      value: step.value,
    });
  }
}

function serializeResult(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

async function runRead(
  provider: JsonRpcProvider,
  encoded: EncodedAction
): Promise<unknown> {
  const ret = await provider.call({
    to: encoded.to,
    data: encoded.data,
    from: SIM_WALLET,
  });
  const fragment = encoded.ethersFragment as Parameters<
    Interface["decodeFunctionResult"]
  >[0];
  const decoded = encoded.iface.decodeFunctionResult(fragment, ret);
  const outputs =
    JSON.parse((fragment as { format: (f: string) => string }).format("json"))
      .outputs ?? [];
  const values = serializeResult([...decoded]);
  return structureAbiOutputs(values as unknown[], outputs);
}

export function runSimulation(opts: {
  protocol: string;
  chainId: string;
  rpcUrl: string;
}): void {
  const protocol = getProtocol(opts.protocol);
  if (!protocol) {
    test.skip(`protocol ${opts.protocol} not registered`, () => {
      /* no-op */
    });
    return;
  }
  const provider = new JsonRpcProvider(opts.rpcUrl, undefined, {
    staticNetwork: true,
  });

  test(
    `setup: provision ${opts.protocol} state`,
    async () => {
      await provisionSetup(provider, opts.protocol, opts.chainId);
    },
    WRITE_TIMEOUT_MS * 3
  );

  const expectations = protocol.testData?.[opts.chainId]?.expectations ?? {};

  for (const phase of ["read", "write"] as const) {
    const plan = planPhaseFixtures(
      protocol,
      opts.protocol,
      opts.chainId,
      phase
    );
    for (const c of plan) {
      if (c.kind === "no-actions") {
        continue;
      }
      if (c.kind === "no-protocol") {
        continue;
      }
      if (c.kind === "skip") {
        test.skip(`${phase} ${c.action.slug} (${c.reason})`, () => {
          /* documented in testData.skipped */
        });
        continue;
      }
      const action = c.action;
      test(
        `${phase} ${action.slug}`,
        async () => {
          const encoded = encodeBoundAction(
            protocol,
            action,
            opts.chainId,
            SIM_WALLET
          );
          if (phase === "read") {
            const result = await runRead(provider, encoded);
            const checks = expectations[action.slug] ?? [];
            for (const expectation of checks) {
              const failure = checkOutputExpectation(
                { success: true, result },
                expectation
              );
              expect(failure, failure ?? "").toBeNull();
            }
          } else {
            await impersonatedSend(provider, SIM_WALLET, {
              to: encoded.to,
              data: encoded.data,
              value: encoded.value,
            });
          }
        },
        phase === "read" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS
      );
    }
  }
}
