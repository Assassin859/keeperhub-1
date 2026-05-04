import "server-only";

import { ethers } from "ethers";
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

const HEX_32_BYTES = /^0x[a-fA-F0-9]{64}$/;

export type BreachCoreInput = {
  network: string;
  coalitionId: string;
  breachingParty: string;
  evidenceHash: string;
  evidenceUri?: string;
  gasLimitMultiplier?: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type BreachResult =
  | { success: true; transactionHash: string; transactionLink: string }
  | { success: false; error: string };

type RawCoalitionForBreach = {
  participants: string[];
  state: number | bigint;
  stakeToken: string;
  stakePerParty: number | bigint;
};

export async function breachCore(
  input: BreachCoreInput
): Promise<BreachResult> {
  const { network, coalitionId, breachingParty, evidenceHash, gasLimitMultiplier, _context } =
    input;

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

  if (!ethers.isAddress(breachingParty)) {
    return {
      success: false,
      error: `Invalid breachingParty address: ${breachingParty}`,
    };
  }

  if (!HEX_32_BYTES.test(evidenceHash)) {
    return {
      success: false,
      error: "Invalid evidenceHash: must be 0x followed by 64 hex chars",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Coalition breach]",
    "breach"
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

  let coalition: RawCoalitionForBreach;
  try {
    coalition = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "getCoalition",
      args: [parsedId],
      isView: true,
    })) as RawCoalitionForBreach;
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Coalition breach] Failed to read coalition state",
      error,
      { plugin_name: "coalition", action_name: "breach" }
    );
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }

  if (Number(coalition.state) !== 2) {
    return { success: false, error: "Coalition is not active" };
  }

  const partyLower = breachingParty.toLowerCase();
  const isParticipant = coalition.participants.some(
    (p: string) => p.toLowerCase() === partyLower
  );
  if (!isParticipant) {
    return {
      success: false,
      error: "Address is not a participant of this coalition",
    };
  }

  let alreadyBreached: boolean;
  try {
    alreadyBreached = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "isBreached",
      args: [parsedId, breachingParty],
      isView: true,
    })) as boolean;
  } catch (error) {
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }

  if (alreadyBreached) {
    return { success: false, error: "Party already marked breached" };
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
          functionKey: "recordBreach",
          args: [parsedId, breachingParty, evidenceHash],
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
        "[Coalition breach] recordBreach tx failed",
        error,
        { plugin_name: "coalition", action_name: "breach" }
      );
      return {
        success: false,
        error: formatContractError(error, coalitionInterface),
      };
    }
  });
}
