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

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type SignCoreInput = {
  network: string;
  coalitionId: string;
  skipApproval?: string;
  gasLimitMultiplier?: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type SignResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      approvalTransactionHash?: string;
      wasAlreadySigned: boolean;
    }
  | {
      success: false;
      error: string;
      // Approval may have already landed when the subsequent sign() failed.
      // Surface the hash so the user knows the on-chain allowance is set
      // and replays of `sign` will skip approve.
      approvalTransactionHash?: string;
    };

type RawCoalitionForSign = {
  stakeToken: string;
  stakePerParty: bigint | string;
  state: number | bigint;
  participants: string[];
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: state pre-check + conditional approve + sign
export async function signCore(input: SignCoreInput): Promise<SignResult> {
  const { network, coalitionId, skipApproval, gasLimitMultiplier, _context } =
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

  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Coalition sign]",
    "sign"
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

  let coalition: RawCoalitionForSign;
  try {
    coalition = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "getCoalition",
      args: [parsedId],
      isView: true,
    })) as RawCoalitionForSign;
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Coalition sign] Failed to read coalition state",
      error,
      { plugin_name: "coalition", action_name: "sign" }
    );
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }

  if (Number(coalition.state) !== 1) {
    return {
      success: false,
      error: `Coalition is not in PROPOSED state (current state code: ${Number(coalition.state)})`,
    };
  }

  let alreadySigned: boolean;
  try {
    alreadySigned = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "isSigned",
      args: [parsedId, walletAddress],
      isView: true,
    })) as boolean;
  } catch (error) {
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }

  if (alreadySigned) {
    return {
      success: true,
      transactionHash: "",
      transactionLink: "",
      wasAlreadySigned: true,
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

  const stakeBig =
    typeof coalition.stakePerParty === "bigint"
      ? coalition.stakePerParty
      : BigInt(coalition.stakePerParty);

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

    let approvalHash: string | undefined;
    if (skipApproval !== "yes") {
      let allowance: bigint;
      try {
        allowance = (await adapter.readContract(rpcManager, {
          contractAddress: coalition.stakeToken,
          abi: ERC20_ABI as unknown as ethers.InterfaceAbi,
          functionKey: "allowance",
          args: [walletAddress, coalitionAddress],
          isView: true,
        })) as bigint;
      } catch (error) {
        return {
          success: false,
          error: `Failed to check allowance: ${getErrorMessage(error)}`,
        };
      }

      if (allowance < stakeBig) {
        try {
          const approveReceipt = await adapter.executeContractCall(
            signer,
            {
              contractAddress: coalition.stakeToken,
              abi: ERC20_ABI as unknown as ethers.InterfaceAbi,
              functionKey: "approve",
              args: [coalitionAddress, stakeBig],
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
          approvalHash = approveReceipt.hash;
        } catch (error) {
          logUserError(
            ErrorCategory.NETWORK_RPC,
            "[Coalition sign] Approval tx failed",
            error,
            { plugin_name: "coalition", action_name: "sign" }
          );
          return {
            success: false,
            error: `Approval failed: ${formatContractError(error, coalitionInterface)}`,
          };
        }
      }
    }

    try {
      const receipt = await adapter.executeContractCall(
        signer,
        {
          contractAddress: coalitionAddress,
          abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
          functionKey: "sign",
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
        approvalTransactionHash: approvalHash,
        wasAlreadySigned: false,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[Coalition sign] Sign tx failed",
        error,
        { plugin_name: "coalition", action_name: "sign" }
      );
      return {
        success: false,
        error: formatContractError(error, coalitionInterface),
        approvalTransactionHash: approvalHash,
      };
    }
  });
}
