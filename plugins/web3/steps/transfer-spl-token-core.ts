import "server-only";

import {
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  ExtensionType,
  getAccountLenForMint,
  getAssociatedTokenAddressSync,
  getDefaultAccountState,
  getExtensionTypes,
  type Mint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import type { AccountInfo } from "@solana/web3.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import type { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";
import type { NonceSession } from "@/lib/web3/nonce-manager";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { SOLANA_BASE_FEE_LAMPORTS } from "@/lib/web3/solana-fees";
import {
  buildSolanaSignerFromWallet,
  getOrganizationWallet,
} from "@/lib/web3/wallet-helpers";

/**
 * Serializing a legacy Transaction requires a recentBlockhash and a feePayer or
 * serialize() throws. SolanaChainAdapter.sendTransaction overwrites the
 * blockhash with a freshly fetched one before signing, so this placeholder never
 * reaches the signer or the chain. PublicKey.default is 32 zero bytes, which is
 * valid base58 and satisfies the serializer.
 */
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

/**
 * Mint extensions that a plain transferChecked cannot honour. Rejecting them up
 * front turns an opaque simulation failure into an actionable error.
 */
const UNSUPPORTED_EXTENSIONS = new Map<ExtensionType, string>([
  [
    ExtensionType.TransferHook,
    "the mint has a transfer hook, which requires resolving extra accounts",
  ],
  [ExtensionType.NonTransferable, "the mint is non-transferable"],
]);

export type TransferSplTokenCoreInput = {
  network: string;
  mint: string;
  recipientAddress: string;
  amount: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type TransferSplTokenResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
      gasUsedUnits: string;
      effectiveGasPrice: string;
      amount: string;
      recipient: string;
      mint: string;
      decimals: number;
      recipientTokenAccount: string;
      createdRecipientAccount: boolean;
    }
  | { success: false; error: string };

type SolanaAccount = AccountInfo<Buffer> | null;

type TransferContext = {
  adapter: SolanaChainAdapter;
  chainId: number;
  ownerPk: PublicKey;
  ownerAddress: string;
  recipientPk: PublicKey;
  mintPk: PublicKey;
  amount: string;
  solanaSigner: SolanaTransactionSigner;
};

/**
 * Exported for dispatch-routing tests, mirroring isSolanaTransferPath in
 * transfer-funds-core.ts.
 */
export function isSplTransferPath(chainId: number): boolean {
  return isSolanaChain(chainId);
}

function parsePublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function isTokenProgram(programId: PublicKey): boolean {
  return (
    programId.equals(TOKEN_PROGRAM_ID) || programId.equals(TOKEN_2022_PROGRAM_ID)
  );
}

/**
 * Returns the reason a mint cannot be transferred, or null when it can.
 */
function findUnsupportedExtension(mint: Mint): string | null {
  const extensions = getExtensionTypes(mint.tlvData);

  for (const extension of extensions) {
    const reason = UNSUPPORTED_EXTENSIONS.get(extension);
    if (reason) {
      return reason;
    }
  }

  if (extensions.includes(ExtensionType.DefaultAccountState)) {
    if (getDefaultAccountState(mint)?.state === AccountState.Frozen) {
      return "the mint freezes new token accounts by default";
    }
  }

  return null;
}

function parseAmount(
  amount: string,
  decimals: number
): { raw: bigint } | { error: string } {
  try {
    const raw = ethers.parseUnits(amount.trim(), decimals);
    if (raw < BigInt(0)) {
      return { error: `Invalid token amount: ${amount}` };
    }
    return { raw };
  } catch {
    return { error: `Invalid token amount: ${amount}` };
  }
}

/**
 * Builds the transfer as a prebuilt serialized transaction. SolanaChainAdapter
 * rejects executeContractCall (Solana has no ABI-encoded calls), so serialized
 * bytes in request.data are the only way onto its Turnkey signing and
 * submit/failover path.
 */
function buildSerializedTransfer(args: {
  ownerPk: PublicKey;
  recipientPk: PublicKey;
  mintPk: PublicKey;
  senderAta: PublicKey;
  recipientAta: PublicKey;
  programId: PublicKey;
  amountRaw: bigint;
  decimals: number;
  needsRecipientAta: boolean;
}): string {
  const transaction = new Transaction();

  if (args.needsRecipientAta) {
    // Idempotent: if the account appears between our read and inclusion, this
    // no-ops instead of failing the whole transfer.
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        args.ownerPk,
        args.recipientAta,
        args.recipientPk,
        args.mintPk,
        args.programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // transferChecked over transfer: it re-validates decimals on-chain, so a bad
  // decimals read fails loudly instead of moving a wrong amount, and Token-2022
  // rejects plain transfer for transfer-fee mints.
  transaction.add(
    createTransferCheckedInstruction(
      args.senderAta,
      args.mintPk,
      args.recipientAta,
      args.ownerPk,
      args.amountRaw,
      args.decimals,
      [],
      args.programId
    )
  );

  transaction.feePayer = args.ownerPk;
  transaction.recentBlockhash = PLACEHOLDER_BLOCKHASH;

  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

async function resolveWallet(
  organizationId: string
): Promise<
  { signer: SolanaTransactionSigner; address: string } | { error: string }
> {
  try {
    const wallet = await getOrganizationWallet(organizationId);
    const signer = buildSolanaSignerFromWallet(wallet);
    // buildSolanaSignerFromWallet throws when solanaAddress is absent.
    return { signer, address: wallet.solanaAddress as string };
  } catch (error) {
    return {
      error: `Failed to initialize Solana wallet: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Reads the mint account. Its owner is the source of truth for legacy SPL vs
 * Token-2022; unpackMint validates that owner and parses Token-2022 TLV data.
 */
async function resolveMint(
  adapter: SolanaChainAdapter,
  mintPk: PublicKey
): Promise<{ mint: Mint; programId: PublicKey } | { error: string }> {
  let mintInfo: SolanaAccount;
  try {
    mintInfo = await adapter.executeWithSolanaFailover(
      (connection) => connection.getAccountInfo(mintPk, "confirmed"),
      "read"
    );
  } catch (error) {
    return { error: `Failed to read mint account: ${getErrorMessage(error)}` };
  }

  if (!mintInfo) {
    return { error: `Mint account not found: ${mintPk.toBase58()}` };
  }

  const programId = mintInfo.owner;
  if (!isTokenProgram(programId)) {
    return {
      error: `${mintPk.toBase58()} is not an SPL token mint (owned by ${programId.toBase58()})`,
    };
  }

  return { mint: unpackMint(mintPk, mintInfo, programId), programId };
}

async function runPreflight(args: {
  adapter: SolanaChainAdapter;
  ownerAddress: string;
  senderAta: PublicKey;
  recipientAta: PublicKey;
  recipientPk: PublicKey;
  programId: PublicKey;
  mintAccount: Mint;
  amountRaw: bigint;
}): Promise<{ needsRecipientAta: boolean } | { error: string }> {
  const { adapter, senderAta, recipientAta, programId, mintAccount, amountRaw } =
    args;

  let accounts: SolanaAccount[];
  try {
    accounts = await adapter.executeWithSolanaFailover(
      (connection) =>
        connection.getMultipleAccountsInfo(
          [senderAta, recipientAta, args.recipientPk],
          "confirmed"
        ),
      "read"
    );
  } catch (error) {
    return { error: `Failed to read token accounts: ${getErrorMessage(error)}` };
  }

  const [senderInfo, recipientAtaInfo, recipientInfo] = accounts;

  // A recipient address that is itself a token account means the caller pasted
  // a token account instead of a wallet; the ATA derived from it would be
  // unrecoverable.
  if (recipientInfo && isTokenProgram(recipientInfo.owner)) {
    return { error: "Recipient must be a wallet address, not a token account" };
  }

  if (!senderInfo) {
    return {
      error: `Wallet has no token account for mint ${mintAccount.address.toBase58()}`,
    };
  }

  const senderAccount = unpackAccount(senderAta, senderInfo, programId);
  if (senderAccount.amount < amountRaw) {
    return {
      error: `Insufficient token balance. Have: ${senderAccount.amount.toString()}, Need: ${amountRaw.toString()} (raw units)`,
    };
  }

  const needsRecipientAta = !recipientAtaInfo;

  const rent = await resolveRentLamports(adapter, mintAccount, needsRecipientAta);
  if ("error" in rent) {
    return rent;
  }

  const solCheck = await checkSolBalance({
    adapter,
    ownerAddress: args.ownerAddress,
    rentLamports: rent.lamports,
    needsRecipientAta,
  });
  if (solCheck) {
    return { error: solCheck };
  }

  return { needsRecipientAta };
}

async function resolveRentLamports(
  adapter: SolanaChainAdapter,
  mintAccount: Mint,
  needsRecipientAta: boolean
): Promise<{ lamports: bigint } | { error: string }> {
  if (!needsRecipientAta) {
    return { lamports: BigInt(0) };
  }

  try {
    // getAccountLenForMint, not the fixed 165-byte helper: Token-2022 accounts
    // size from the mint's extensions. It ignores the ImmutableOwner the ATA
    // program adds, so this slightly under-estimates; the preflight is advisory
    // and the on-chain create pulls what it actually needs.
    const lamports = await adapter.executeWithSolanaFailover(
      (connection) =>
        connection.getMinimumBalanceForRentExemption(
          getAccountLenForMint(mintAccount)
        ),
      "read"
    );
    return { lamports: BigInt(lamports) };
  } catch (error) {
    return { error: `Failed to read rent exemption: ${getErrorMessage(error)}` };
  }
}

/** Returns an error message, or null when the balance covers fee plus rent. */
async function checkSolBalance(args: {
  adapter: SolanaChainAdapter;
  ownerAddress: string;
  rentLamports: bigint;
  needsRecipientAta: boolean;
}): Promise<string | null> {
  try {
    const balance = await args.adapter.getBalance(undefined, args.ownerAddress);
    const required = SOLANA_BASE_FEE_LAMPORTS + args.rentLamports;
    if (balance >= required) {
      return null;
    }
    const breakdown = args.needsRecipientAta
      ? `${SOLANA_BASE_FEE_LAMPORTS.toString()} fee + ${args.rentLamports.toString()} rent for the recipient's new token account`
      : `${SOLANA_BASE_FEE_LAMPORTS.toString()} fee`;
    return `Insufficient SOL balance. Have: ${balance.toString()} lamports, Need: ${required.toString()} lamports (${breakdown})`;
  } catch (error) {
    return `Failed to check SOL balance: ${getErrorMessage(error)}`;
  }
}

async function executeTransfer(
  ctx: TransferContext
): Promise<TransferSplTokenResult> {
  const { adapter, chainId, ownerPk, recipientPk, mintPk, amount } = ctx;

  const resolved = await resolveMint(adapter, mintPk);
  if ("error" in resolved) {
    return { success: false, error: resolved.error };
  }
  const { mint: mintAccount, programId } = resolved;

  const unsupported = findUnsupportedExtension(mintAccount);
  if (unsupported) {
    return {
      success: false,
      error: `Cannot transfer ${mintPk.toBase58()}: ${unsupported}`,
    };
  }

  const parsed = parseAmount(amount, mintAccount.decimals);
  if ("error" in parsed) {
    return { success: false, error: parsed.error };
  }

  const senderAta = getAssociatedTokenAddressSync(
    mintPk,
    ownerPk,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  // Recipients may legitimately be program-owned (PDA) accounts, so off-curve
  // owners are allowed here.
  const recipientAta = getAssociatedTokenAddressSync(
    mintPk,
    recipientPk,
    true,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const preflight = await runPreflight({
    adapter,
    ownerAddress: ctx.ownerAddress,
    senderAta,
    recipientAta,
    recipientPk,
    programId,
    mintAccount,
    amountRaw: parsed.raw,
  });
  if ("error" in preflight) {
    return { success: false, error: preflight.error };
  }

  const data = buildSerializedTransfer({
    ownerPk,
    recipientPk,
    mintPk,
    senderAta,
    recipientAta,
    programId,
    amountRaw: parsed.raw,
    decimals: mintAccount.decimals,
    needsRecipientAta: preflight.needsRecipientAta,
  });

  try {
    // gasOverrides is deliberately empty. With an override set,
    // normalizeSolanaTransaction takes its decompile/compileToV0Message branch
    // and silently rewrites this legacy transaction as v0 - a path Turnkey's
    // Solana signer has never been exercised against. Left empty, it only
    // normalizes the fee payer, which already equals the signer, so the
    // serialized bytes pass through untouched. A compute budget, if ever
    // needed, belongs in the instructions built above.
    const receipt = await adapter.sendTransaction(
      undefined as unknown as ethers.Signer, // unused by SolanaChainAdapter
      { to: recipientPk.toBase58(), data },
      undefined as unknown as NonceSession, // unused by SolanaChainAdapter
      { solanaSigner: ctx.solanaSigner, gasOverrides: {} }
    );

    const transactionLink = await adapter.getTransactionUrl(receipt.hash);

    return {
      success: true,
      transactionHash: receipt.hash,
      transactionLink,
      // Mirrors the native Solana path: the lamport fee is not computed, and the
      // raw compute-unit fields are returned instead.
      gasUsed: "0",
      gasUsedUnits: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      amount,
      recipient: recipientPk.toBase58(),
      mint: mintPk.toBase58(),
      decimals: mintAccount.decimals,
      recipientTokenAccount: recipientAta.toBase58(),
      createdRecipientAccount: preflight.needsRecipientAta,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Transfer SPL Token] Transaction failed",
      error,
      {
        plugin_name: "web3",
        action_name: "transfer-spl-token",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function transferSplTokenCore(
  input: TransferSplTokenCoreInput
): Promise<TransferSplTokenResult> {
  const { network, mint, recipientAddress, amount, _context } = input;

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!isSplTransferPath(chainId)) {
    return {
      success: false,
      error: `Transfer SPL Token is only supported on Solana networks, got: ${network}`,
    };
  }

  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  const mintPk = parsePublicKey(mint);
  if (!mintPk) {
    return { success: false, error: `Invalid Solana mint address: ${mint}` };
  }

  const recipientPk = parsePublicKey(recipientAddress);
  if (!recipientPk) {
    return {
      success: false,
      error: `Invalid Solana recipient address: ${recipientAddress}`,
    };
  }

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Transfer SPL Token]",
    "transfer-spl-token"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const wallet = await resolveWallet(orgCtx.organizationId);
  if ("error" in wallet) {
    return { success: false, error: wallet.error };
  }

  const ownerPk = parsePublicKey(wallet.address);
  if (!ownerPk) {
    return {
      success: false,
      error: `Organization wallet has an invalid Solana address: ${wallet.address}`,
    };
  }

  return await executeTransfer({
    adapter: getChainAdapter(chainId) as SolanaChainAdapter,
    chainId,
    ownerPk,
    ownerAddress: wallet.address,
    recipientPk,
    mintPk,
    amount,
    solanaSigner: wallet.signer,
  });
}
