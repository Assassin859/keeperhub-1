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

export type ActivateCoreInput = {
  network: string;
  coalitionId: string;
  gasLimitMultiplier?: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type ActivateResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      alreadyActive: boolean;
    }
  | { success: false; error: string };

type RawCoalitionForActivate = {
  participants: string[];
  signedCount: number | bigint;
  state: number | bigint;
};

export async function activateCore(
  input: ActivateCoreInput
): Promise<ActivateResult> {
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
    "[Coalition activate]",
    "activate"
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

  let coalition: RawCoalitionForActivate;
  try {
    coalition = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "getCoalition",
      args: [parsedId],
      isView: true,
    })) as RawCoalitionForActivate;
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Coalition activate] Failed to read coalition state",
      error,
      { plugin_name: "coalition", action_name: "activate" }
    );
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }

  const stateNum = Number(coalition.state);
  if (stateNum === 2) {
    return {
      success: true,
      alreadyActive: true,
      transactionHash: "",
      transactionLink: "",
    };
  }
  if (stateNum !== 1) {
    return {
      success: false,
      error: `Coalition is not in PROPOSED state (current state code: ${stateNum})`,
    };
  }
  const signedCount = Number(coalition.signedCount);
  const totalParticipants = coalition.participants.length;
  if (signedCount !== totalParticipants) {
    return {
      success: false,
      error: `Not all participants have signed (${signedCount}/${totalParticipants})`,
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
          functionKey: "activate",
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
        alreadyActive: false,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[Coalition activate] Activate tx failed",
        error,
        { plugin_name: "coalition", action_name: "activate" }
      );
      return {
        success: false,
        error: formatContractError(error, coalitionInterface),
      };
    }
  });
}
