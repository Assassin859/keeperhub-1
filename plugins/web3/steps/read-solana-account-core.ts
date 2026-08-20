/**
 * Core read-solana-account logic.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 */
import "server-only";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  fetchSolanaAccountInfo,
  resolveSolanaAccountAddress,
} from "@/lib/web3/solana-account-reader";

export type ReadSolanaAccountCoreInput = {
  network: string;
  accountAddress: string;
  _context?: { executionId?: string };
};

export type ReadSolanaAccountResult =
  | { success: true; exists: false }
  | {
      success: true;
      exists: true;
      owner: string;
      lamports: number;
      executable: boolean;
      rentEpoch: number | null;
      dataBase64: string;
      dataLength: number;
      addressLink: string;
    }
  | { success: false; error: string };

export async function readSolanaAccountCore(
  input: ReadSolanaAccountCoreInput
): Promise<ReadSolanaAccountResult> {
  const { network, accountAddress } = input;

  const resolved = resolveSolanaAccountAddress(network, accountAddress);
  if ("error" in resolved) {
    return { success: false, error: resolved.error };
  }
  const { adapter, pubkey } = resolved;

  const fetched = await fetchSolanaAccountInfo(adapter, pubkey);
  if ("error" in fetched) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Read Solana Account] Failed to read account",
      fetched.error,
      { plugin_name: "web3", action_name: "read-solana-account" }
    );
    return { success: false, error: fetched.error };
  }

  if (!fetched.accountInfo) {
    return { success: true, exists: false };
  }

  const { executable, owner, lamports, data, rentEpoch } =
    fetched.accountInfo;
  const addressLink = await adapter.getAddressUrl(accountAddress);

  return {
    success: true,
    exists: true,
    owner: owner.toBase58(),
    lamports,
    executable,
    rentEpoch: rentEpoch ?? null,
    dataBase64: data.toString("base64"),
    dataLength: data.length,
    addressLink,
  };
}
