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

const HEX_32_BYTES = /^0x[a-fA-F0-9]{64}$/;

type StrippedReceipt = {
  hash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: number;
};

export type ProposeCoreInput = {
  network: string;
  participants: string;
  termsHash: string;
  deadlineUnix: string;
  stakeToken: string;
  stakePerParty: string;
  gasLimitMultiplier?: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type ProposeResult =
  | {
      success: true;
      coalitionId: string;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
    }
  | { success: false; error: string };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validation + tx flow follows write-contract-core pattern
export async function proposeCore(
  input: ProposeCoreInput
): Promise<ProposeResult> {
  const {
    network,
    participants,
    termsHash,
    deadlineUnix,
    stakeToken,
    stakePerParty,
    gasLimitMultiplier,
    _context,
  } = input;

  let parsedParticipants: string[];
  try {
    const raw = JSON.parse(participants);
    if (!Array.isArray(raw)) {
      throw new Error("must be a JSON array");
    }
    parsedParticipants = raw.map((p) => String(p));
  } catch (error) {
    return {
      success: false,
      error: `Invalid participants list: ${getErrorMessage(error)}`,
    };
  }

  if (parsedParticipants.length < 2 || parsedParticipants.length > 20) {
    return {
      success: false,
      error: `Invalid participant count: must be between 2 and 20 (got ${parsedParticipants.length})`,
    };
  }
  for (const addr of parsedParticipants) {
    if (!ethers.isAddress(addr)) {
      return { success: false, error: `Invalid participant address: ${addr}` };
    }
  }

  if (!HEX_32_BYTES.test(termsHash)) {
    return {
      success: false,
      error: "Invalid termsHash: must be 0x followed by 64 hex chars",
    };
  }

  let deadlineBig: bigint;
  try {
    deadlineBig = BigInt(deadlineUnix);
  } catch (error) {
    return {
      success: false,
      error: `Invalid deadlineUnix: ${getErrorMessage(error)}`,
    };
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (deadlineBig <= nowSec) {
    return { success: false, error: "deadlineUnix must be in the future" };
  }

  if (!ethers.isAddress(stakeToken)) {
    return {
      success: false,
      error: `Invalid stakeToken address: ${stakeToken}`,
    };
  }

  let stakeBig: bigint;
  try {
    stakeBig = BigInt(stakePerParty);
    if (stakeBig <= BigInt(0)) {
      throw new Error("must be greater than zero");
    }
  } catch (error) {
    return {
      success: false,
      error: `Invalid stakePerParty: ${getErrorMessage(error)}`,
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Coalition propose]",
    "propose"
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
    logUserError(
      ErrorCategory.VALIDATION,
      "[Coalition propose] Chain/address resolution failed",
      error,
      { plugin_name: "coalition", action_name: "propose" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  let rpcUrl: string;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Coalition propose] RPC resolution failed",
      error,
      { plugin_name: "coalition", action_name: "propose" }
    );
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

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);
  const priorityFeeOverride = parsePriorityFeeGwei(undefined);

  const args = [
    parsedParticipants,
    termsHash,
    deadlineBig,
    stakeToken,
    stakeBig,
  ];

  const txContext: TransactionContext = {
    organizationId,
    executionId: _context?.executionId ?? `direct-${generateId()}`,
    workflowId: undefined,
    chainId,
    rpcUrl,
    rpcManager,
  };

  if (isGasSponsorshipEnabled()) {
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
        functionName: "propose",
        args,
        value: undefined,
      });

      if (sponsored !== null) {
        const adapter = getChainAdapter(chainId);
        const transactionLink = await adapter.getTransactionUrl(
          sponsored.transactionHash
        );
        return {
          success: true,
          coalitionId: "",
          transactionHash: sponsored.transactionHash,
          transactionLink,
          gasUsed: sponsored.gasUsed,
        };
      }
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Coalition propose] Sponsorship failed, falling back to direct signing",
        error,
        { plugin_name: "coalition", action_name: "propose" }
      );
    }
  }

  const adapter = getChainAdapter(chainId);

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
      const receipt = (await adapter.executeContractCall(
        signer,
        {
          contractAddress: coalitionAddress,
          abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
          functionKey: "propose",
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
      )) as StrippedReceipt;

      // The platform's TransactionReceipt strips logs (see lib/web3/chain-adapter/evm.ts).
      // Refetch via the RPC manager to access the Proposed event.
      let fullReceipt: ethers.TransactionReceipt | null = null;
      try {
        fullReceipt = await rpcManager.executeWithFailover(
          (rpcProvider) => rpcProvider.getTransactionReceipt(receipt.hash),
          "read"
        );
      } catch (error) {
        logUserError(
          ErrorCategory.NETWORK_RPC,
          "[Coalition propose] Failed to refetch receipt for event parsing",
          error,
          { plugin_name: "coalition", action_name: "propose" }
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

      const proposedArgs = parseCoalitionEvent(fullReceipt.logs, "Proposed");
      if (!proposedArgs) {
        return {
          success: false,
          error:
            "Coalition.propose tx confirmed but Proposed event was not emitted; investigate via the tx hash",
        };
      }

      const coalitionId = String(proposedArgs.id ?? proposedArgs[0]);
      const transactionLink = await adapter.getTransactionUrl(receipt.hash);
      const gasCostWei = (
        receipt.gasUsed * receipt.effectiveGasPrice
      ).toString();

      return {
        success: true,
        coalitionId,
        transactionHash: receipt.hash,
        transactionLink,
        gasUsed: gasCostWei,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[Coalition propose] executeContractCall failed",
        error,
        {
          plugin_name: "coalition",
          action_name: "propose",
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
