import "server-only";

import type { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/para/wallet-helpers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { generateId } from "@/lib/utils/id";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { formatContractError } from "@/lib/web3/decode-revert-error";
import {
  parsePriorityFeeGwei,
  resolveGasLimitOverrides,
} from "@/lib/web3/gas-defaults";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";
import { COALITION_ABI } from "../contracts/coalition-abi";
import { coalitionInterface, getCoalitionAddress } from "./coalition-core";

export type DissolveCoreInput = {
  network: string;
  coalitionId: string;
  gasLimitMultiplier?: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type DissolveResult =
  | { success: true; transactionHash: string; transactionLink: string }
  | { success: false; error: string };

type RawCoalitionForDissolve = {
  state: number | bigint;
  participants: string[];
};

export async function dissolveCore(
  input: DissolveCoreInput
): Promise<DissolveResult> {
  const { network, coalitionId, gasLimitMultiplier, _context } = input;

  let parsedId: bigint;
  try {
    parsedId = BigInt(coalitionId);
    if (parsedId <= BigInt(0)) {
      throw new Error("coalitionId must be positive");
    }
  } catch (error) {
    return {
      success: false,
      error: `Invalid coalitionId: ${getErrorMessage(error)}`,
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Coalition dissolve]",
    "dissolve"
  );
  if (!orgCtx.success) {
    return { success: false, error: orgCtx.error };
  }
  const { organizationId, userId } = orgCtx;

  let chainId: number;
  let coalitionAddress: `0x${string}`;
  try {
    chainId = getChainIdFromNetwork(network);
    coalitionAddress = getCoalitionAddress(chainId);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  let rpcUrl: string;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  let walletAddress: string;
  try {
    walletAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to get wallet address: ${getErrorMessage(error)}`,
    };
  }

  const adapter = getChainAdapter(chainId);

  let coalition: RawCoalitionForDissolve;
  try {
    coalition = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "getCoalition",
      args: [parsedId],
      isView: true,
    })) as RawCoalitionForDissolve;
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Coalition dissolve] Failed to read coalition state",
      error,
      { plugin_name: "coalition", action_name: "dissolve" }
    );
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }

  if (Number(coalition.state) !== 2) {
    return { success: false, error: "Coalition is not active" };
  }

  // Pre-check participation client-side so the workflow doesn't pay gas for a
  // tx that would revert with NotParticipant on-chain (dissolve is restricted
  // to participants in Coalition.sol).
  const callerLower = walletAddress.toLowerCase();
  const isCallerParticipant = coalition.participants.some(
    (p) => p.toLowerCase() === callerLower
  );
  if (!isCallerParticipant) {
    return {
      success: false,
      error: "Caller is not a participant of this coalition",
    };
  }

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);
  const priorityFeeOverride = parsePriorityFeeGwei(undefined);

  const txContext: TransactionContext = {
    organizationId,
    executionId: _context?.executionId ?? `direct-${generateId()}`,
    workflowId: undefined,
    chainId,
    rpcUrl,
    rpcManager,
  };

  return withNonceSession(txContext, walletAddress, async (session) => {
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize wallet: ${getErrorMessage(error)}`,
      };
    }

    try {
      const receipt = await adapter.executeContractCall(
        signer,
        {
          contractAddress: coalitionAddress,
          abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
          functionKey: "dissolve",
          args: [parsedId],
          value: undefined,
        },
        session,
        {
          gasOverrides: {
            multiplierOverride,
            gasLimitOverride,
            priorityFeeOverride,
          },
          workflowId: undefined,
          rpcManager,
        }
      );

      const transactionLink = await adapter.getTransactionUrl(receipt.hash);
      return {
        success: true,
        transactionHash: receipt.hash,
        transactionLink,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[Coalition dissolve] Dissolve tx failed",
        error,
        { plugin_name: "coalition", action_name: "dissolve" }
      );
      return {
        success: false,
        error: formatContractError(error, coalitionInterface),
      };
    }
  });
}
