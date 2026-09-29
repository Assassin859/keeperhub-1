import "server-only";

import { and, eq } from "drizzle-orm";
import {
  type Abi,
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Hex,
  isAddress,
  parseUnits,
} from "viem";
import { checkGasCredits } from "@/lib/billing/gas-credits";
import erc20AbiJson from "@/lib/contracts/abis/erc20.json";
import { db } from "@/lib/db";
import { explorerConfigs, supportedTokens } from "@/lib/db/schema";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  type GasTopUpChainId,
  isGasTopUpChain,
} from "@/lib/execute/gas-top-up-chains";
import { checkStablecoinTransferAmount } from "@/lib/execute/stablecoin-cap";
import { getTransactionUrl } from "@/lib/explorer";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { resolveSignerForNode } from "@/lib/safe/signer-resolver";
import { getErrorMessage } from "@/lib/utils";
import { createSponsoredClient } from "@/lib/web3/sponsored-client";
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import { executeSponsoredContractTransaction } from "@/lib/web3/sponsored-transaction-manager";
import { shouldTrySponsorship } from "@/lib/web3/sponsorship-eligibility";
import {
  isSponsoredTxPendingError,
  isSponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";
import quoterAbiJson from "@/protocols/abis/uniswap-quoter.json";
import swapRouterAbiJson from "@/protocols/abis/uniswap-swap-router.json";
import wethAbiJson from "@/protocols/abis/weth.json";
import uniswapV3 from "@/protocols/uniswap-v3";
import wrapped from "@/protocols/wrapped";

const erc20Abi = erc20AbiJson as Abi;
const quoterAbi = quoterAbiJson as Abi;
const swapRouterAbi = swapRouterAbiJson as Abi;
const wethAbi = wethAbiJson as Abi;

/**
 * The USDC/WETH pool each chain swaps through. 0.05% is the deepest USDC/WETH
 * pool on Ethereum, Base and Arbitrum; Sepolia uses the 0.3% tier. The quote
 * is taken against the same tier the swap uses, so a thin or missing pool
 * shows up as a failed or small quote (and a refusal) rather than a bad fill.
 */
const POOL_FEE: Readonly<Record<GasTopUpChainId, number>> = {
  1: 500,
  8453: 500,
  42161: 500,
  11155111: 3000,
};

/** Same default the Tempo DEX swap applies (plugins/tempo/steps/dex-swap.ts). */
export const GAS_TOP_UP_SLIPPAGE_BPS = 50;
const BPS_DENOMINATOR = 10_000;
const WETH_DECIMALS = 18;
const LOG_PREFIX = "[Gas Top-up]";
const ACTION_NAME = "gas-top-up";

/** The quote less a fixed tolerance, in bigint so no precision is lost. */
export function applySlippageFloor(
  quotedOut: bigint,
  slippageBps: number = GAS_TOP_UP_SLIPPAGE_BPS
): bigint {
  return (
    (quotedOut * BigInt(BPS_DENOMINATOR - slippageBps)) /
    BigInt(BPS_DENOMINATOR)
  );
}

type GasTopUpContracts = {
  router: Address;
  quoter: Address;
  weth: Address;
  fee: number;
};

/**
 * Router, quoter and WETH come from the protocol registry definitions rather
 * than local literals, so this route can never swap through an address the
 * protocol integrations (and the stablecoin-cap spender allowlist) do not
 * already know.
 */
export function resolveGasTopUpContracts(
  chainId: GasTopUpChainId
): GasTopUpContracts | null {
  const key = String(chainId);
  const router = uniswapV3.contracts.swapRouter?.addresses[key];
  const quoter = uniswapV3.contracts.quoter?.addresses[key];
  const weth = wrapped.contracts.weth?.addresses[key];
  if (!(router && quoter && weth)) {
    return null;
  }
  if (!(isAddress(router) && isAddress(quoter) && isAddress(weth))) {
    return null;
  }
  return {
    router: getAddress(router),
    quoter: getAddress(quoter),
    weth: getAddress(weth),
    fee: POOL_FEE[chainId],
  };
}

type UsdcToken = { address: Address; decimals: number };

async function resolveUsdc(chainId: number): Promise<UsdcToken | null> {
  const rows = await db
    .select({
      tokenAddress: supportedTokens.tokenAddress,
      decimals: supportedTokens.decimals,
      symbol: supportedTokens.symbol,
    })
    .from(supportedTokens)
    .where(
      and(
        eq(supportedTokens.chainId, chainId),
        eq(supportedTokens.isStablecoin, true)
      )
    );
  const row = rows.find(
    (candidate) =>
      candidate.symbol.toUpperCase() === "USDC" &&
      isAddress(candidate.tokenAddress)
  );
  if (!row) {
    return null;
  }
  return { address: getAddress(row.tokenAddress), decimals: row.decimals };
}

export type GasTopUpPlan = {
  organizationId: string;
  chainId: GasTopUpChainId;
  wallet: Address;
  usdc: UsdcToken;
  contracts: GasTopUpContracts;
  amountUsdc: string;
  amountIn: bigint;
};

export type GasTopUpRefusalCode =
  | "UNSUPPORTED_CHAIN"
  | "USDC_NOT_CONFIGURED"
  | "INVALID_AMOUNT"
  | "STABLECOIN_CAP_EXCEEDED"
  | "SPONSORSHIP_UNAVAILABLE";

export type GasTopUpPreparation =
  | { ok: true; plan: GasTopUpPlan }
  | { ok: false; code: GasTopUpRefusalCode; error: string; field?: string };

/**
 * Everything that can refuse a top-up before an execution is reserved: the
 * chain, the amount against the per-call stablecoin cap, and whether every
 * transaction can go through Turnkey sponsorship. Nothing here signs or sends.
 *
 * Sponsorship is required, not preferred. The wallet this is for typically
 * holds no native balance, so a direct-signing fallback would fail at
 * broadcast anyway, and a partially self-paid sequence is worse than none.
 */
export async function prepareGasTopUp(params: {
  organizationId: string;
  chainId: number;
  amountUsdc: string;
}): Promise<GasTopUpPreparation> {
  const { organizationId, chainId, amountUsdc } = params;

  if (!isGasTopUpChain(chainId)) {
    return {
      ok: false,
      code: "UNSUPPORTED_CHAIN",
      error: `Gas top-up is not available on chain ${chainId}`,
      field: "chainId",
    };
  }

  const contracts = resolveGasTopUpContracts(chainId);
  if (!contracts) {
    return {
      ok: false,
      code: "UNSUPPORTED_CHAIN",
      error: `Uniswap V3 or WETH is not registered on chain ${chainId}`,
      field: "chainId",
    };
  }

  const usdc = await resolveUsdc(chainId);
  if (!usdc) {
    return {
      ok: false,
      code: "USDC_NOT_CONFIGURED",
      error: `USDC is not a supported stablecoin on chain ${chainId}`,
      field: "chainId",
    };
  }

  let amountIn: bigint;
  try {
    amountIn = parseUnits(amountUsdc, usdc.decimals);
  } catch {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      error: `Invalid USDC amount: ${amountUsdc}`,
      field: "amountUsdc",
    };
  }
  if (amountIn <= BigInt(0)) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      error: "amountUsdc must be greater than 0",
      field: "amountUsdc",
    };
  }

  // The swap itself is not a call the stablecoin cap meters, and the approve
  // to SwapRouter02 is exempt as a known protocol spender, so the bound is
  // applied here, as a transfer of the full amount, before anything is sent.
  const cap = await checkStablecoinTransferAmount({
    organizationId,
    chainId,
    tokenAddress: usdc.address,
    amount: amountUsdc,
    context: ACTION_NAME,
  });
  if (cap.kind === "denied") {
    return {
      ok: false,
      code: "STABLECOIN_CAP_EXCEEDED",
      error: cap.error,
      field: "amountUsdc",
    };
  }

  // web3Connection "eoa" pins the sender to the org's Turnkey EOA regardless
  // of any Safe the org runs on this chain: the native balance is for the
  // wallet that pays gas, and that is the EOA.
  const signerMode = await resolveSignerForNode({
    organizationId,
    chainId,
    web3Connection: "eoa",
  });
  if (!shouldTrySponsorship({ chainId, signerMode, sponsorGas: true })) {
    return {
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
      error: `Gas sponsorship is not available on chain ${chainId}; gas top-up only runs sponsored`,
    };
  }

  const credits = await checkGasCredits(organizationId);
  if (!credits.allowed) {
    return {
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
      error: `Gas sponsorship credits are exhausted: ${credits.reason}`,
    };
  }

  const client = await createSponsoredClient(organizationId, chainId);
  if (!client) {
    return {
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
      error:
        "The organization has no active Turnkey wallet eligible for gas sponsorship",
    };
  }

  return {
    ok: true,
    plan: {
      organizationId,
      chainId,
      // The sponsored send always signs from this wallet, so it is also the
      // swap recipient. There is deliberately no caller-supplied recipient.
      wallet: getAddress(client.walletAddress),
      usdc,
      contracts,
      amountUsdc,
      amountIn,
    },
  };
}

export type GasTopUpStepName = "approve" | "swap" | "unwrap";

export type GasTopUpStep = {
  name: GasTopUpStepName;
  status: "confirmed" | "failed" | "skipped";
  transactionHash?: string;
  transactionLink?: string;
  error?: string;
};

export type GasTopUpFailure = {
  step: GasTopUpStepName | "preflight";
  error: string;
  transactionHash?: string;
  broadcastAttempted: boolean;
  errorClass?: ExecutionErrorType;
};

export type GasTopUpResult = {
  success: boolean;
  chainId: GasTopUpChainId;
  wallet: Address;
  steps: GasTopUpStep[];
  usdcSpent?: string;
  quotedWethOut?: string;
  amountOutMinimum?: string;
  wethReceived?: string;
  ethReceived?: string;
  sponsored: true;
  /** True once any step reached Turnkey's broadcast path. */
  broadcastAttempted: boolean;
  /** True once the swap confirmed: the USDC is spent, whatever happens next. */
  swapLanded: boolean;
  /** Sum of the confirmed steps' fees, in wei. */
  gasUsedWei: string;
  finalTransactionHash?: string;
  finalTransactionLink?: string;
  error?: string;
  failure?: GasTopUpFailure;
};

type SendOutcome =
  | {
      kind: "confirmed";
      transactionHash: string;
      transactionLink?: string;
      gasUsedWei: bigint;
    }
  | {
      kind: "failed";
      error: string;
      transactionHash?: string;
      broadcastAttempted: boolean;
      /** Broadcast but unconfirmed: it may still land. */
      pending?: boolean;
      errorClass?: ExecutionErrorType;
    };

async function buildTransactionLink(
  chainId: number,
  hash: string
): Promise<string | undefined> {
  try {
    const config = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    return config ? getTransactionUrl(config, hash) : undefined;
  } catch {
    return;
  }
}

/**
 * One sponsored send, never retried and never re-signed directly.
 *
 * `null` from the sponsored manager means Turnkey declined before anything
 * was broadcast (flag off, credits gone, activity rejected). A write step
 * would fall back to direct signing there; this route fails closed instead.
 */
async function sendSponsored(params: {
  plan: GasTopUpPlan;
  executionId: string;
  rpcUrl: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: unknown[];
}): Promise<SendOutcome> {
  const { plan } = params;
  try {
    const result = await executeSponsoredContractTransaction({
      organizationId: plan.organizationId,
      executionId: params.executionId,
      chainId: plan.chainId,
      rpcUrl: params.rpcUrl,
      walletAddress: plan.wallet,
      to: params.to,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
    });
    if (!result) {
      return {
        kind: "failed",
        error:
          "Gas sponsorship declined the transaction before broadcast; gas top-up does not fall back to self-paid gas",
        broadcastAttempted: false,
      };
    }
    return {
      kind: "confirmed",
      transactionHash: result.transactionHash,
      transactionLink: await buildTransactionLink(
        plan.chainId,
        result.transactionHash
      ),
      gasUsedWei: BigInt(result.gasUsed),
    };
  } catch (error) {
    if (isSponsoredTxRevertError(error) || isSponsoredTxPendingError(error)) {
      const decision = resolveSponsoredSendError(error, {
        logPrefix: LOG_PREFIX,
        actionName: ACTION_NAME,
        chainId: plan.chainId,
      });
      if (!decision.fallback) {
        return {
          kind: "failed",
          error: decision.error,
          transactionHash: decision.transactionHash,
          broadcastAttempted: true,
          pending: isSponsoredTxPendingError(error),
          errorClass: decision.errorClass,
        };
      }
    }
    return {
      kind: "failed",
      error: `Sponsored send failed before broadcast: ${getErrorMessage(error)}`,
      broadcastAttempted: false,
    };
  }
}

async function readBalance(
  rpcManager: RpcProviderManager,
  token: Address,
  owner: Address
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  const raw = await rpcManager.executeWithFailover((provider) =>
    provider.call({ to: token, data })
  );
  return decodeFunctionResult({
    abi: erc20Abi,
    functionName: "balanceOf",
    data: raw as Hex,
  }) as bigint;
}

/**
 * QuoterV2 answers through eth_call (it simulates the swap and returns the
 * amounts), so this reads the pool's price at the moment of the request.
 * Tuple order differs from the router's: amountIn precedes fee here.
 */
export async function quoteUsdcToWeth(
  rpcManager: RpcProviderManager,
  plan: GasTopUpPlan
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: plan.usdc.address,
        tokenOut: plan.contracts.weth,
        amountIn: plan.amountIn,
        fee: plan.contracts.fee,
        sqrtPriceLimitX96: BigInt(0),
      },
    ],
  });
  const raw = await rpcManager.executeWithFailover((provider) =>
    provider.call({ to: plan.contracts.quoter, data })
  );
  const decoded = decodeFunctionResult({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    data: raw as Hex,
  }) as readonly [bigint, bigint, number, bigint];
  return decoded[0];
}

function skippedSteps(from: GasTopUpStepName): GasTopUpStep[] {
  const order: GasTopUpStepName[] = ["approve", "swap", "unwrap"];
  return order
    .slice(order.indexOf(from))
    .map((name) => ({ name, status: "skipped" as const }));
}

function partialMessage(
  step: GasTopUpStepName,
  error: string,
  pending: boolean
): string {
  if (step === "approve") {
    return pending
      ? `Approve is unconfirmed; no USDC has been swapped. ${error}`
      : `Approve failed; no USDC was spent. ${error}`;
  }
  if (step === "swap") {
    return pending
      ? `Approve confirmed; the swap was broadcast but is unconfirmed, so the USDC may or may not have been spent. ${error}`
      : `Approve confirmed but the swap did not complete; no USDC was spent and an approval for exactly the requested amount remains. ${error}`;
  }
  return `Approve and swap confirmed but the unwrap did not complete; the swapped WETH is left unwrapped in the wallet. ${error}`;
}

/**
 * approve(exact amount) -> exactInputSingle(recipient = wallet, floor from a
 * same-request quote) -> WETH.withdraw(received). Three separate sponsored
 * transactions: SwapRouter02's registered ABI has no multicall/unwrapWETH9, so
 * the sequence can stop part-way, and the result says exactly where.
 */
export async function executeGasTopUp(params: {
  plan: GasTopUpPlan;
  executionId: string;
}): Promise<GasTopUpResult> {
  const { plan, executionId } = params;
  const steps: GasTopUpStep[] = [];
  let gasUsedWei = BigInt(0);

  const base = {
    chainId: plan.chainId,
    wallet: plan.wallet,
    sponsored: true as const,
  };

  const refuse = (error: string): GasTopUpResult => ({
    ...base,
    success: false,
    steps: skippedSteps("approve"),
    usdcSpent: "0",
    broadcastAttempted: false,
    swapLanded: false,
    gasUsedWei: "0",
    error,
    failure: { step: "preflight", error, broadcastAttempted: false },
  });

  let rpcManager: RpcProviderManager;
  let rpcUrl: string;
  try {
    rpcManager = await getRpcProvider({ chainId: plan.chainId });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    return refuse(`RPC unavailable: ${getErrorMessage(error)}`);
  }

  let usdcBalance: bigint;
  try {
    usdcBalance = await readBalance(rpcManager, plan.usdc.address, plan.wallet);
  } catch (error) {
    return refuse(`Could not read USDC balance: ${getErrorMessage(error)}`);
  }
  if (usdcBalance < plan.amountIn) {
    return refuse(
      `Insufficient USDC: wallet ${plan.wallet} holds ${formatUnits(usdcBalance, plan.usdc.decimals)} USDC, top-up needs ${plan.amountUsdc}`
    );
  }

  let quotedOut: bigint;
  try {
    quotedOut = await quoteUsdcToWeth(rpcManager, plan);
  } catch (error) {
    return refuse(`Quote failed: ${getErrorMessage(error)}`);
  }
  const amountOutMinimum = applySlippageFloor(quotedOut);
  if (quotedOut <= BigInt(0) || amountOutMinimum <= BigInt(0)) {
    return refuse("Quote returned no WETH for this amount; refusing to swap");
  }

  const quoteFields = {
    quotedWethOut: quotedOut.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
  };

  let wethBefore: bigint | null = null;
  try {
    wethBefore = await readBalance(
      rpcManager,
      plan.contracts.weth,
      plan.wallet
    );
  } catch {
    wethBefore = null;
  }

  const stop = (
    step: GasTopUpStepName,
    outcome: Extract<SendOutcome, { kind: "failed" }>,
    extra: Partial<GasTopUpResult> = {}
  ): GasTopUpResult => {
    const pending = outcome.pending === true;
    const error = partialMessage(step, outcome.error, pending);
    let next: GasTopUpStepName | null = null;
    if (step === "approve") {
      next = "swap";
    } else if (step === "swap") {
      next = "unwrap";
    }
    return {
      ...base,
      ...quoteFields,
      success: false,
      steps: [
        ...steps,
        {
          name: step,
          status: "failed",
          ...(outcome.transactionHash
            ? { transactionHash: outcome.transactionHash }
            : {}),
          error: outcome.error,
        },
        ...(next ? skippedSteps(next) : []),
      ],
      // Unknown while a broadcast swap is unconfirmed.
      ...(step === "swap" && pending ? {} : { usdcSpent: "0" }),
      broadcastAttempted:
        outcome.broadcastAttempted || steps.some((s) => s.transactionHash),
      swapLanded: false,
      gasUsedWei: gasUsedWei.toString(),
      error,
      failure: {
        step,
        error,
        transactionHash: outcome.transactionHash,
        broadcastAttempted: outcome.broadcastAttempted,
        errorClass: outcome.errorClass,
      },
      ...extra,
    };
  };

  const approve = await sendSponsored({
    plan,
    executionId,
    rpcUrl,
    to: plan.usdc.address,
    abi: erc20Abi,
    functionName: "approve",
    args: [plan.contracts.router, plan.amountIn],
  });
  if (approve.kind === "failed") {
    return stop("approve", approve);
  }
  gasUsedWei += approve.gasUsedWei;
  steps.push({
    name: "approve",
    status: "confirmed",
    transactionHash: approve.transactionHash,
    transactionLink: approve.transactionLink,
  });

  const swap = await sendSponsored({
    plan,
    executionId,
    rpcUrl,
    to: plan.contracts.router,
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: plan.usdc.address,
        tokenOut: plan.contracts.weth,
        fee: plan.contracts.fee,
        recipient: plan.wallet,
        amountIn: plan.amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: BigInt(0),
      },
    ],
  });
  if (swap.kind === "failed") {
    return stop("swap", swap);
  }
  gasUsedWei += swap.gasUsedWei;
  steps.push({
    name: "swap",
    status: "confirmed",
    transactionHash: swap.transactionHash,
    transactionLink: swap.transactionLink,
  });

  // The router enforces amountOutMinimum, so the wallet received at least
  // that much. The balance delta is the exact figure; when it cannot be read,
  // or reads below the floor because something else moved WETH meanwhile, the
  // floor is the amount known to have arrived and is what gets unwrapped.
  let wethReceived = amountOutMinimum;
  if (wethBefore !== null) {
    try {
      const wethAfter = await readBalance(
        rpcManager,
        plan.contracts.weth,
        plan.wallet
      );
      const delta = wethAfter - wethBefore;
      if (delta > amountOutMinimum) {
        wethReceived = delta;
      }
    } catch {
      wethReceived = amountOutMinimum;
    }
  }

  const swapLandedFields: Partial<GasTopUpResult> = {
    usdcSpent: plan.amountUsdc,
    swapLanded: true,
    wethReceived: formatUnits(wethReceived, WETH_DECIMALS),
    broadcastAttempted: true,
  };

  const unwrap = await sendSponsored({
    plan,
    executionId,
    rpcUrl,
    to: plan.contracts.weth,
    abi: wethAbi,
    functionName: "withdraw",
    args: [wethReceived],
  });
  if (unwrap.kind === "failed") {
    return stop("unwrap", unwrap, swapLandedFields);
  }
  gasUsedWei += unwrap.gasUsedWei;
  steps.push({
    name: "unwrap",
    status: "confirmed",
    transactionHash: unwrap.transactionHash,
    transactionLink: unwrap.transactionLink,
  });

  return {
    ...base,
    ...quoteFields,
    success: true,
    steps,
    usdcSpent: plan.amountUsdc,
    wethReceived: formatUnits(wethReceived, WETH_DECIMALS),
    ethReceived: formatUnits(wethReceived, WETH_DECIMALS),
    broadcastAttempted: true,
    swapLanded: true,
    gasUsedWei: gasUsedWei.toString(),
    finalTransactionHash: unwrap.transactionHash,
    finalTransactionLink: unwrap.transactionLink,
  };
}
