import "server-only";

import { ethers } from "ethers";
import type { Hex } from "viem";
import { createHeldPayment } from "@/lib/tempo/held-payments";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  buildTransferWithMemoCall,
  normalizeMemo,
  signTempoTx,
} from "./tempo-tx-core";
import {
  assertTempoChain,
  parseTimestamp,
  resolveTempoToken,
} from "./tempo-step-helpers";

// A manual hold defaults its on-chain safety expiry to 24h; a scheduled hold
// defaults it to 1h past the target send. The window must clear this buffer
// past now (and past the send) so the blob does not lapse before it broadcasts.
const DEFAULT_MANUAL_WINDOW_SEC = 24 * 60 * 60;
const DEFAULT_SCHEDULE_SLACK_SEC = 60 * 60;
const MIN_WINDOW_BUFFER_SEC = 60;
// Held payments broadcast later, so widen the gas ceiling well past the
// sign-time adaptive read. maxFeePerGas is a ceiling, not the fee paid.
const HELD_PAYMENT_FEE_MULTIPLIER = 4;
const HELD_PAYMENT_MAX_FEE_FLOOR_WEI = BigInt(50_000_000_000); // 50 gwei

type BroadcastMode = "manual" | "schedule";

export type HoldPaymentInput = StepInput & {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  amount: string;
  recipientAddress: string;
  memo?: string;
  broadcastMode?: BroadcastMode;
  broadcastAt?: string;
  validBefore?: string;
};

export type HoldPaymentResult =
  | {
      success: true;
      paymentId: string;
      precomputedHash: string;
      from: string;
      to: string;
      amount: string;
      memo: string;
      broadcastMode: BroadcastMode;
      broadcastAt: string | null;
      validBefore: number;
      status: "pending";
      chainId: number;
    }
  | { success: false; error: string };

type ResolvedWindow =
  | { ok: true; broadcastAt: Date | null; validBeforeSec: number }
  | { ok: false; error: string };

/**
 * Resolve the broadcast target and the on-chain safety window from the mode and
 * the raw inputs. A manual hold has no target (released on demand); a scheduled
 * hold requires a future target. validAfter is intentionally left unset so a
 * poller firing a hair early is never rejected on-chain -- KeeperHub owns the
 * timing and validBefore is the only chain-side guard.
 */
function resolveWindow(
  mode: BroadcastMode,
  broadcastAtRaw: string | undefined,
  validBeforeRaw: string | undefined,
  nowSec: number
): ResolvedWindow {
  let broadcastAtSec: number | undefined;
  try {
    broadcastAtSec = parseTimestamp(broadcastAtRaw);
    const parsedValidBefore = parseTimestamp(validBeforeRaw);
    if (mode === "schedule") {
      if (broadcastAtSec === undefined) {
        return {
          ok: false,
          error: "broadcastAt is required when broadcastMode is 'schedule'.",
        };
      }
      if (broadcastAtSec <= nowSec) {
        return {
          ok: false,
          error: "broadcastAt must be in the future for a scheduled hold.",
        };
      }
      const validBeforeSec =
        parsedValidBefore ?? broadcastAtSec + DEFAULT_SCHEDULE_SLACK_SEC;
      if (validBeforeSec <= broadcastAtSec) {
        return {
          ok: false,
          error: "validBefore must be after the scheduled broadcast time.",
        };
      }
      return {
        ok: true,
        broadcastAt: new Date(broadcastAtSec * 1000),
        validBeforeSec,
      };
    }
    const validBeforeSec =
      parsedValidBefore ?? nowSec + DEFAULT_MANUAL_WINDOW_SEC;
    if (validBeforeSec < nowSec + MIN_WINDOW_BUFFER_SEC) {
      return {
        ok: false,
        error:
          "The payment window closes too soon: validBefore must be at least 60 seconds ahead so the held payment can be broadcast before it lapses.",
      };
    }
    return { ok: true, broadcastAt: null, validBeforeSec };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

async function stepHandler(
  input: HoldPaymentInput
): Promise<HoldPaymentResult> {
  const { network, tokenConfig, amount, recipientAddress, memo, _context } =
    input;
  const broadcastMode: BroadcastMode =
    input.broadcastMode === "schedule" ? "schedule" : "manual";

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
    assertTempoChain(chainId);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!ethers.isAddress(recipientAddress)) {
    return {
      success: false,
      error: `Invalid recipient address: ${recipientAddress}`,
    };
  }
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const window = resolveWindow(
    broadcastMode,
    input.broadcastAt,
    input.validBefore,
    nowSec
  );
  if (!window.ok) {
    return { success: false, error: window.error };
  }

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }
  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Tempo Hold Payment]",
    "hold-payment"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  try {
    const rpcManager = await getRpcProvider({
      chainId,
      userId: orgCtx.userId,
    });
    const token = await resolveTempoToken(tokenConfig, chainId, rpcManager);
    const amountRaw = ethers.parseUnits(amount, token.decimals);
    const recipient = ethers.getAddress(recipientAddress) as Hex;
    const memoBytes = normalizeMemo(memo);

    const call = buildTransferWithMemoCall(
      token.address,
      recipient,
      amountRaw,
      memoBytes
    );
    const signed = await signTempoTx({
      organizationId: orgCtx.organizationId,
      userId: orgCtx.userId,
      chainId,
      calls: [call],
      feeToken: token.address,
      validBefore: window.validBeforeSec,
      executionId: _context?.executionId,
      maxFeePerGasMultiplier: HELD_PAYMENT_FEE_MULTIPLIER,
      maxFeePerGasFloor: HELD_PAYMENT_MAX_FEE_FLOOR_WEI,
    });

    const held = await createHeldPayment({
      organizationId: orgCtx.organizationId,
      createdByUserId: orgCtx.userId,
      workflowId: _context?.workflowId,
      executionId: _context?.executionId,
      chainId,
      fromAddress: signed.from,
      toAddress: recipient,
      tokenAddress: token.address,
      amountRaw: amountRaw.toString(),
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amountDisplay: amount,
      memo: memoBytes,
      serializedTx: signed.serialized,
      precomputedHash: signed.hash,
      nonceKey: signed.nonceKey.toString(),
      maxFeePerGas: signed.maxFeePerGas.toString(),
      validBefore: window.validBeforeSec,
      broadcastAt: window.broadcastAt,
    });

    return {
      success: true,
      paymentId: held.id,
      precomputedHash: signed.hash,
      from: signed.from,
      to: recipient,
      amount,
      memo: memoBytes,
      broadcastMode,
      broadcastAt: window.broadcastAt ? window.broadcastAt.toISOString() : null,
      validBefore: window.validBeforeSec,
      status: "pending",
      chainId,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Tempo Hold Payment] hold-payment failed",
      error,
      { plugin_name: "tempo", action_name: "hold-payment" }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function holdPaymentStep(
  input: HoldPaymentInput
): Promise<HoldPaymentResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "tempo",
      actionName: "hold-payment",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

holdPaymentStep.maxRetries = 0;

export const _integrationType = "tempo";
