import "server-only";

import type { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { formatContractError } from "@/lib/web3/decode-revert-error";
import { COALITION_ABI } from "../contracts/coalition-abi";
import {
  type CoalitionState,
  coalitionInterface,
  getCoalitionAddress,
  stateLabel,
} from "./coalition-core";

export type CheckStatusCoreInput = {
  network: string;
  coalitionId: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type CheckStatusResult =
  | {
      success: true;
      state: CoalitionState;
      signedCount: number;
      breachedCount: number;
      slashedCount: number;
      totalParticipants: number;
      ready: boolean;
      participants: string[];
      termsHash: string;
      deadline: string;
      stakeToken: string;
      stakePerParty: string;
    }
  | { success: false; error: string };

type RawCoalition = {
  termsHash: string;
  participants: string[];
  stakeToken: string;
  stakePerParty: bigint | string;
  deadline: bigint | string;
  signedCount: number | bigint;
  breachedCount: number | bigint;
  slashedCount: number | bigint;
  state: number | bigint;
};

export async function checkStatusCore(
  input: CheckStatusCoreInput
): Promise<CheckStatusResult> {
  const { network, coalitionId } = input;

  let parsedId: bigint;
  try {
    parsedId = BigInt(coalitionId);
    if (parsedId < BigInt(0)) {
      throw new Error("coalitionId must be non-negative");
    }
  } catch (error) {
    return {
      success: false,
      error: `Invalid coalitionId: ${getErrorMessage(error)}`,
    };
  }

  let chainId: number;
  let coalitionAddress: `0x${string}`;
  try {
    chainId = getChainIdFromNetwork(network);
    coalitionAddress = getCoalitionAddress(chainId);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Coalition check-status] Failed to resolve chain or address",
      error,
      { plugin_name: "coalition", action_name: "check-status" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    rpcManager = await getRpcProvider({ chainId });
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Coalition check-status] Failed to resolve RPC",
      error,
      { plugin_name: "coalition", action_name: "check-status" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  try {
    const adapter = getChainAdapter(chainId);
    const raw = (await adapter.readContract(rpcManager, {
      contractAddress: coalitionAddress,
      abi: COALITION_ABI as unknown as ethers.InterfaceAbi,
      functionKey: "getCoalition",
      args: [parsedId],
      isView: true,
    })) as RawCoalition;

    const stateNum = Number(raw.state);
    if (stateNum === 0) {
      return {
        success: false,
        error: `Coalition ${coalitionId} does not exist`,
      };
    }

    const state = stateLabel(stateNum);
    const signedCount = Number(raw.signedCount);
    const breachedCount = Number(raw.breachedCount);
    const slashedCount = Number(raw.slashedCount);
    const totalParticipants = raw.participants.length;
    const ready =
      state === "PROPOSED" && signedCount === totalParticipants;

    return {
      success: true,
      state,
      signedCount,
      breachedCount,
      slashedCount,
      totalParticipants,
      ready,
      participants: raw.participants,
      termsHash: raw.termsHash,
      deadline: String(raw.deadline),
      stakeToken: raw.stakeToken,
      stakePerParty: String(raw.stakePerParty),
    };
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Coalition check-status] readContract failed",
      error,
      {
        plugin_name: "coalition",
        action_name: "check-status",
        chain_id: String(chainId),
      }
    );
    return {
      success: false,
      error: formatContractError(error, coalitionInterface),
    };
  }
}
