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
import { executeSponsoredContractTransaction } from "@/lib/web3/sponsored-transaction-manager";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";
import { COALITION_ABI } from "../contracts/coalition-abi";
import {
  coalitionInterface,
  getCoalitionAddress,
  parseCoalitionEvent,
} from "./coalition-core";

export type SlashCoreInput = {
  network: string;
  coalitionId: string;
  party: string;
  usePrivateMempool?: string;
  strict?: string;
  priorityFeeGwei?: string;
  gasLimitMultiplier?: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type SlashResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      amountRedistributed: string;
      party: string;
    }
  | { success: false; error: string };

type RawCoalitionForSlash = {
  state: number | bigint;
  participants: string[];
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validation + reliability config + sponsorship + direct path + receipt refetch
export async function slashCore(input: SlashCoreInput): Promise<SlashResult> {
  const {
    network,
    coalitionId,
    party,
    usePrivateMempool: usePrivateMempoolStr,
    strict: strictStr,
    priorityFeeGwei,
    gasLimitMultiplier,
    _context,
  } = input;

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

  if (!ethers.isAddress(party)) {
    return { success: false, error: `Invalid party address: ${party}` };
  }

  const usePrivateMempool = usePrivateMempoolStr === "yes";
  const strictBool = strictStr === "yes";

  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Coalition slash]",
    "slash"
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
    rpcManager = await getRpcProvider({
      chainId,
      userId,
      usePrivateMempool,
      strict: strictBool,
    });
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

  let coalition: RawCoalitionForSlash;
  try {
    coalition = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "getCoalition",
      args: [parsedId],
      isView: true,
    })) as RawCoalitionForSlash;
  } catch (error) {
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }

  if (Number(coalition.state) !== 2) {
    return { success: false, error: "Coalition is not active" };
  }

  let breached: boolean;
  try {
    breached = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "isBreached",
      args: [parsedId, party],
      isView: true,
    })) as boolean;
  } catch (error) {
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }

  if (!breached) {
    return { success: false, error: "Party has not been marked breached" };
  }

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);
  const priorityFeeOverride = parsePriorityFeeGwei(priorityFeeGwei);

  const args = [parsedId, party];

  const txContext: TransactionContext = {
    organizationId,
    executionId: _context?.executionId ?? `direct-${generateId()}`,
    workflowId: undefined,
    chainId,
    rpcUrl,
    rpcManager,
  };

  if (!usePrivateMempool && isGasSponsorshipEnabled()) {
    try {
      const sponsored = await executeSponsoredContractTransaction({
        organizationId,
        executionId: _context?.executionId ?? "direct-execution",
        chainId,
        rpcUrl,
        walletAddress,
        to: coalitionAddress,
        // biome-ignore lint/suspicious/noExplicitAny: typed ABI accepted by helper as InterfaceAbi
        abi: COALITION_ABI as any,
        functionName: "slash",
        args,
        value: undefined,
      });

      if (sponsored !== null) {
        const transactionLink = await adapter.getTransactionUrl(
          sponsored.transactionHash
        );

        let fullReceipt: ethers.TransactionReceipt | null = null;
        try {
          fullReceipt = await rpcManager.executeWithFailover(
            (rpcProvider) =>
              rpcProvider.getTransactionReceipt(sponsored.transactionHash),
            "read"
          );
        } catch {
          // Refetch failed; surface tx but with empty amountRedistributed
        }

        const slashedArgs = fullReceipt
          ? parseCoalitionEvent(fullReceipt.logs, "Slashed")
          : null;
        const amountRedistributed = slashedArgs
          ? String(slashedArgs.amountRedistributed ?? slashedArgs[2])
          : "0";

        return {
          success: true,
          transactionHash: sponsored.transactionHash,
          transactionLink,
          amountRedistributed,
          party,
        };
      }
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Coalition slash] Sponsorship failed, falling back to direct signing",
        error,
        { plugin_name: "coalition", action_name: "slash" }
      );
    }
  }

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
          functionKey: "slash",
          args,
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

      let fullReceipt: ethers.TransactionReceipt | null = null;
      try {
        fullReceipt = await rpcManager.executeWithFailover(
          (rpcProvider) => rpcProvider.getTransactionReceipt(receipt.hash),
          "read"
        );
      } catch (error) {
        logUserError(
          ErrorCategory.NETWORK_RPC,
          "[Coalition slash] Failed to refetch receipt for event parsing",
          error,
          { plugin_name: "coalition", action_name: "slash" }
        );
        return {
          success: false,
          error: `Tx ${receipt.hash} confirmed but receipt could not be refetched: ${getErrorMessage(error)}`,
        };
      }

      if (!fullReceipt) {
        return {
          success: false,
          error: `Tx ${receipt.hash} confirmed but provider returned null receipt`,
        };
      }

      const slashedArgs = parseCoalitionEvent(fullReceipt.logs, "Slashed");
      if (!slashedArgs) {
        return {
          success: false,
          error: "Slash tx confirmed but Slashed event not emitted",
        };
      }

      const amountRedistributed = String(
        slashedArgs.amountRedistributed ?? slashedArgs[2]
      );
      const transactionLink = await adapter.getTransactionUrl(receipt.hash);

      return {
        success: true,
        transactionHash: receipt.hash,
        transactionLink,
        amountRedistributed,
        party,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[Coalition slash] executeContractCall failed",
        error,
        {
          plugin_name: "coalition",
          action_name: "slash",
          chain_id: String(chainId),
        }
      );
      return {
        success: false,
        error: formatContractError(error, coalitionInterface),
      };
    }
  });
}
