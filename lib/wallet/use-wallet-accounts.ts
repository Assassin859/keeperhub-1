"use client";

import { useMemo } from "react";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import {
  getChainOrderIndex,
  getDisplayChainName,
} from "@/components/overlays/wallet/chain-utils";
import type { ChainData } from "@/lib/wallet/types";
import type { SafeRow } from "@/lib/wallet/use-org-wallet";

type WalletAccountsInput = {
  walletAddress?: string | null;
  solanaAddress?: string | null;
  solanaIsTestnet: boolean;
  safes: SafeRow[];
  chains: ChainData[];
};

export type WalletAccounts = {
  turnkey: WalletAccountKind | null;
  solana: WalletAccountKind | null;
  safes: WalletAccountKind[];
  all: WalletAccountKind[];
};

/** Stable URL segment for an account, used by the wallet detail route. */
export function accountSlug(account: WalletAccountKind): string {
  if (account.kind === "safe") {
    return account.safeId;
  }
  return account.family === "solana" ? "solana" : "evm";
}

export function accountTitle(account: WalletAccountKind): string {
  if (account.kind === "safe") {
    return `Safe · ${account.chainName}`;
  }
  return account.family === "solana"
    ? "Turnkey EOA (SVM Compatible)"
    : "Turnkey EOA (EVM Compatible)";
}

/** Derives the renderable account rows from the raw wallet payload. */
export function useWalletAccounts({
  walletAddress,
  solanaAddress,
  solanaIsTestnet,
  safes,
  chains,
}: WalletAccountsInput): WalletAccounts {
  return useMemo(() => {
    const turnkey: WalletAccountKind | null = walletAddress
      ? { kind: "turnkey", address: walletAddress, family: "evm" }
      : null;

    const solana: WalletAccountKind | null = solanaAddress
      ? {
          kind: "turnkey",
          address: solanaAddress,
          family: "solana",
          solanaIsTestnet,
        }
      : null;

    const safeAccounts: WalletAccountKind[] = safes
      .slice()
      .sort(
        (a, b) => getChainOrderIndex(a.chainId) - getChainOrderIndex(b.chainId)
      )
      .map((s) => {
        const chain = chains.find((c) => c.chainId === s.chainId);
        return {
          address: s.safeAddress,
          chainId: s.chainId,
          chainName: getDisplayChainName(chain?.name ?? `Chain ${s.chainId}`),
          isSigningActive: s.isSigningActive,
          kind: "safe" as const,
          safeId: s.id,
        };
      });

    return {
      all: [turnkey, solana, ...safeAccounts].filter(
        (a): a is WalletAccountKind => a !== null
      ),
      safes: safeAccounts,
      solana,
      turnkey,
    };
  }, [walletAddress, solanaAddress, solanaIsTestnet, safes, chains]);
}
