/**
 * Tier 1 event-decoding simulation.
 *
 * The registry declares protocol events consumed by the Event trigger, but
 * the Tier 2 runner fires workflows over the webhook endpoint, which ignores
 * trigger config entirely - so event decoding has no execution coverage. This
 * harness closes that gap: for each registered event it emits a real,
 * impersonated transaction on the fork (reusing an existing write fixture
 * where one already emits the event, else a targeted emitter call), then
 * asserts the event-trigger decoder parses the emitted log into the shape the
 * trigger layer consumes.
 *
 * The decoder under test is the registry's own event ABI fragment
 * (buildEventAbiFragment) fed to an ethers Interface - the exact artifact the
 * Event trigger stores as contractABI and decodes logs with (see
 * plugins/web3/steps/query-events.ts decodeEventArgs and
 * lib/workflow/editor/trigger-output-fields.ts getEventTriggerOutputFields).
 * A pass proves the registry event definition (name, param types, indexed
 * flags) matches the real on-chain event and decodes into named args.
 *
 * Events that cannot be emitted on the fork are documented skips in
 * testData[chain].events.skipped, keyed by event slug with a reason naming
 * the real constraint - the vitest reporter surfaces them on every run.
 */

import {
  Interface,
  JsonRpcProvider,
  type Log,
  type TransactionReceipt,
  ZeroAddress,
  ZeroHash,
  concat,
  id,
  parseEther,
  zeroPadValue,
} from "ethers";
import { beforeAll, expect, test } from "vitest";
import {
  buildEventAbiFragment,
  getProtocol,
  type ProtocolEvent,
} from "@/lib/protocol-registry";
import { encodeBoundAction } from "@/lib/test-data/encode-action";
import { withImpersonation } from "../../protocol-coverage/_shared/funding";
import { SIM_WALLET } from "./simulate";

// Emitting a fresh Safe plus a handful of self-called state transitions runs
// several sequential impersonated transactions through the fork; keep the
// emit phase's budget generous while the per-event decode assertions stay
// cheap (pure decode of already-collected logs).
const EMIT_TIMEOUT_MS = 240_000;
const GAS_LIMIT_MULTIPLIER = BigInt(2);

type TxRequest = { to: string; data?: string; value?: bigint };

async function sendAndWait(
  provider: JsonRpcProvider,
  from: string,
  tx: TxRequest
): Promise<TransactionReceipt> {
  return withImpersonation(provider, from, async (signer) => {
    const estimated = await signer.estimateGas(tx);
    const sent = await signer.sendTransaction({
      ...tx,
      gasLimit: estimated * GAS_LIMIT_MULTIPLIER,
    });
    const receipt = await sent.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`event emitter tx to ${tx.to} reverted`);
    }
    return receipt;
  });
}

function serializeArgs(
  inputs: readonly { name: string }[],
  args: readonly unknown[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [index, input] of inputs.entries()) {
    const name = input.name || `arg${index}`;
    out[name] = JSON.parse(
      JSON.stringify(args[index], (_, v) =>
        typeof v === "bigint" ? v.toString() : v
      )
    );
  }
  return out;
}

/**
 * Assert the registry event ABI fragment decodes a real emitted log into the
 * trigger-layer shape: a topic-0 match locates the log, parseLog decodes it,
 * and every declared input surfaces as a named, serializable arg.
 */
function assertEventDecodes(event: ProtocolEvent, logs: readonly Log[]): void {
  const iface = new Interface(JSON.parse(buildEventAbiFragment(event)));
  const fragment = iface.getEvent(event.eventName);
  if (!fragment) {
    throw new Error(`no event fragment for ${event.eventName}`);
  }
  const match = logs.find((l) => l.topics[0] === fragment.topicHash);
  expect(
    match,
    `no emitted log matched topic0 for event ${event.slug} (${event.eventName})`
  ).toBeDefined();
  if (!match) {
    return;
  }
  const parsed = iface.parseLog({ topics: [...match.topics], data: match.data });
  expect(parsed, `parseLog returned null for ${event.slug}`).not.toBeNull();
  if (!parsed) {
    return;
  }
  expect(parsed.name).toBe(event.eventName);
  const args = serializeArgs(fragment.inputs, parsed.args);
  expect(Object.keys(args)).toHaveLength(event.inputs.length);
  for (const input of event.inputs) {
    expect(
      Object.hasOwn(args, input.name),
      `decoded args missing declared input ${input.name}`
    ).toBe(true);
  }
}

// -- Emitters ----------------------------------------------------------------

type Emitter = (provider: JsonRpcProvider, chainId: string) => Promise<Log[]>;

/** rETH deposit: the existing write fixture. depositPool.deposit emits
 *  DepositReceived and the rETH mint it triggers emits TokensMinted. */
async function emitRocketPool(
  provider: JsonRpcProvider,
  chainId: string
): Promise<Log[]> {
  const protocol = getProtocol("rocket-pool");
  const deposit = protocol?.actions.find((a) => a.slug === "deposit");
  if (!(protocol && deposit)) {
    throw new Error("rocket-pool deposit fixture unavailable");
  }
  const encoded = encodeBoundAction(protocol, deposit, chainId, SIM_WALLET);
  const receipt = await sendAndWait(provider, SIM_WALLET, {
    to: encoded.to,
    data: encoded.data,
    value: encoded.value,
  });
  return [...receipt.logs];
}

/** stETH.submit stakes ETH for stETH and emits Submitted; needs only native
 *  gas, so a targeted call covers it without the whale a wrap would need. */
async function emitLido(
  provider: JsonRpcProvider,
  chainId: string
): Promise<Log[]> {
  const steth = getProtocol("lido")?.contracts.steth?.addresses[chainId];
  if (!steth) {
    throw new Error(`lido steth address missing for chain ${chainId}`);
  }
  const iface = new Interface([
    "function submit(address _referral) payable returns (uint256)",
  ]);
  const receipt = await sendAndWait(provider, SIM_WALLET, {
    to: steth,
    data: iface.encodeFunctionData("submit", [ZeroAddress]),
    value: parseEther("0.01"),
  });
  return [...receipt.logs];
}

// Canonical Safe v1.4.1 deployments (same address on every chain).
const SAFE_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_SINGLETON = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const SAFE_SENTINEL = "0x0000000000000000000000000000000000000001";
const SAFE_DUMMY_OWNER = "0x000000000000000000000000000000000000a001";
const SAFE_DUMMY_OWNER_2 = "0x000000000000000000000000000000000000a002";
const SAFE_DUMMY_MODULE = "0x000000000000000000000000000000000000a003";
const SAFE_DUMMY_HANDLER = "0x000000000000000000000000000000000000a004";

const SAFE_IFACE = new Interface([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function setGuard(address guard)",
  "function setFallbackHandler(address handler)",
  "function approveHash(bytes32 hashToApprove)",
]);
const SAFE_FACTORY_IFACE = new Interface([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

/**
 * Deploy a fresh 1-of-1 Safe owned by the impersonated wallet and drive it
 * through its state-changing calls to emit each Safe event. execTransaction is
 * authorized with an approved-hash signature (r = owner, s = 0, v = 1): Safe's
 * checkSignatures accepts it when msg.sender is that owner, so no ECDSA key or
 * EIP-712 hash is needed. Every threshold-raising call is sequenced last so
 * each execTransaction still validates against a threshold of 1 at call time.
 */
async function emitSafe(
  provider: JsonRpcProvider,
  _chainId: string
): Promise<Log[]> {
  const setupData = SAFE_IFACE.encodeFunctionData("setup", [
    [SIM_WALLET],
    1n,
    ZeroAddress,
    "0x",
    ZeroAddress,
    ZeroAddress,
    0n,
    ZeroAddress,
  ]);
  const saltNonce = BigInt(Date.now());
  const createData = SAFE_FACTORY_IFACE.encodeFunctionData(
    "createProxyWithNonce",
    [SAFE_SINGLETON, setupData, saltNonce]
  );
  const predicted = await provider.call({
    to: SAFE_FACTORY,
    data: createData,
    from: SIM_WALLET,
  });
  const [safeAddr] = SAFE_FACTORY_IFACE.decodeFunctionResult(
    "createProxyWithNonce",
    predicted
  ) as unknown as [string];

  const logs: Log[] = [];
  const deployReceipt = await sendAndWait(provider, SIM_WALLET, {
    to: SAFE_FACTORY,
    data: createData,
  });
  logs.push(...deployReceipt.logs);

  const signature = concat([zeroPadValue(SIM_WALLET, 32), ZeroHash, "0x01"]);
  const execTransaction = async (innerData: string): Promise<void> => {
    const data = SAFE_IFACE.encodeFunctionData("execTransaction", [
      safeAddr,
      0n,
      innerData,
      0,
      0n,
      0n,
      0n,
      ZeroAddress,
      ZeroAddress,
      signature,
    ]);
    const receipt = await sendAndWait(provider, SIM_WALLET, {
      to: safeAddr,
      data,
    });
    logs.push(...receipt.logs);
  };

  await execTransaction(
    SAFE_IFACE.encodeFunctionData("addOwnerWithThreshold", [
      SAFE_DUMMY_OWNER,
      1n,
    ])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("enableModule", [SAFE_DUMMY_MODULE])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("disableModule", [
      SAFE_SENTINEL,
      SAFE_DUMMY_MODULE,
    ])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("setGuard", [ZeroAddress])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("setFallbackHandler", [SAFE_DUMMY_HANDLER])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("removeOwner", [
      SAFE_SENTINEL,
      SAFE_DUMMY_OWNER,
      1n,
    ])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("addOwnerWithThreshold", [
      SAFE_DUMMY_OWNER_2,
      2n,
    ])
  );

  const approveReceipt = await sendAndWait(provider, SIM_WALLET, {
    to: safeAddr,
    data: SAFE_IFACE.encodeFunctionData("approveHash", [
      id("keeperhub-event-coverage"),
    ]),
  });
  logs.push(...approveReceipt.logs);
  return logs;
}

const EMITTERS: Record<string, Emitter> = {
  "rocket-pool": emitRocketPool,
  lido: emitLido,
  safe: emitSafe,
};

export function runEventSimulation(opts: {
  protocol: string;
  chainId: string;
  rpcUrl: string;
}): void {
  const protocol = getProtocol(opts.protocol);
  const events = protocol?.events ?? [];
  if (!(protocol && events.length > 0)) {
    return;
  }

  const skipped = protocol.testData?.[opts.chainId]?.events?.skipped ?? {};
  const emittable = events.filter((e) => !skipped[e.slug]);

  const provider = new JsonRpcProvider(opts.rpcUrl, undefined, {
    staticNetwork: true,
  });

  let collected: Log[] = [];
  if (emittable.length > 0) {
    const emitter = EMITTERS[opts.protocol];
    beforeAll(async () => {
      if (!emitter) {
        throw new Error(`no event emitter registered for ${opts.protocol}`);
      }
      // 10 ETH native gas for the impersonated wallet, matching the action
      // simulation harness.
      await provider.send("anvil_setBalance", [
        SIM_WALLET,
        "0x8ac7230489e80000",
      ]);
      collected = await emitter(provider, opts.chainId);
    }, EMIT_TIMEOUT_MS);
  }

  for (const event of events) {
    const reason = skipped[event.slug];
    if (reason) {
      test.skip(`event ${event.slug} (${reason})`, () => {
        /* documented in testData.events.skipped */
      });
      continue;
    }
    test(`event ${event.slug}`, () => {
      assertEventDecodes(event, collected);
    });
  }
}
