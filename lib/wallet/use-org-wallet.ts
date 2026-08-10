"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  type WithdrawableAsset,
  WithdrawModal,
} from "@/components/overlays/withdraw-modal";
import { authClient, useSession } from "@/lib/auth-client";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { buildWithdrawableAssets } from "@/lib/wallet/build-withdrawable-assets";
import type {
  ChainBalance,
  ChainData,
  SupportedToken,
  SupportedTokenBalance,
  TokenBalance,
  TokenData,
  WalletData,
} from "@/lib/wallet/types";
import { useWalletBalances } from "@/lib/wallet/use-wallet-balances";
import { useInvalidateWalletInfo } from "@/lib/wallet/use-wallet-info";
import {
  addTrackedToken,
  createWallet,
  fetchChains,
  fetchDeployedSafes,
  fetchSupportedTokens,
  fetchTrackedTokens,
  fetchWallet,
  removeTrackedToken,
  type SafeRow as SafeRowType,
} from "@/lib/wallet/wallet-api";

export type SafeRow = SafeRowType;

export type OrgWalletState = {
  walletLoading: boolean;
  walletData: WalletData | null;
  chains: ChainData[];
  solanaIsTestnet: boolean;
  tokens: TokenData[];
  supportedTokens: SupportedToken[];
  safes: SafeRow[];
  setSafes: React.Dispatch<React.SetStateAction<SafeRow[]>>;
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  supportedTokenBalances: SupportedTokenBalance[];
  isLoadingBalances: boolean;
  loadWallet: () => Promise<void>;
  fetchSafes: () => Promise<SafeRow[]>;
  handleAddToken: (chainId: number, tokenAddress: string) => Promise<void>;
  handleRemoveToken: (tokenId: string, symbol: string) => Promise<void>;
  handleCreateWallet: (email: string) => Promise<void>;
  buildAssets: () => WithdrawableAsset[];
  handleWithdraw: (chainId: number, tokenAddress?: string) => void;
};

function findAssetIndex(
  assets: WithdrawableAsset[],
  chainId: number,
  tokenAddress?: string
): number {
  const idx = tokenAddress
    ? assets.findIndex(
        (a) => a.chainId === chainId && a.tokenAddress === tokenAddress
      )
    : assets.findIndex((a) => a.chainId === chainId && a.type === "native");
  return idx >= 0 ? idx : 0;
}

/**
 * Shared data layer for every surface that manages the organization wallet.
 * The wallet overlay and the settings hub wallets page both mount this so the
 * fetch shape, the token mutations and the withdraw entry point stay in one
 * place.
 */
export function useOrgWallet(): OrgWalletState {
  const { push } = useOverlay();
  const { data: session } = useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const invalidateWalletInfo = useInvalidateWalletInfo();

  const [walletLoading, setWalletLoading] = useState(true);
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [chains, setChains] = useState<ChainData[]>([]);
  const [solanaIsTestnet, setSolanaIsTestnet] = useState(false);
  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [supportedTokens, setSupportedTokens] = useState<SupportedToken[]>([]);
  const [safes, setSafes] = useState<SafeRow[]>([]);

  const {
    balances,
    tokenBalances,
    supportedTokenBalances,
    loading: isLoadingBalances,
    fetchBalances,
  } = useWalletBalances();

  const refreshSafes = useCallback(async (): Promise<SafeRow[]> => {
    const rows = await fetchDeployedSafes();
    setSafes(rows);
    return rows;
  }, []);

  const loadWallet = useCallback(async (): Promise<void> => {
    setWalletLoading(true);
    try {
      const data = await fetchWallet();
      setWalletData(data);
      setWalletLoading(false);
      if (!data.hasWallet) {
        return;
      }

      const [chainResult, trackedTokens, supported] = await Promise.all([
        fetchChains(),
        fetchTrackedTokens(),
        fetchSupportedTokens(),
        refreshSafes(),
      ]);
      setChains(chainResult.evmChains);
      setSolanaIsTestnet(chainResult.solanaIsTestnet);
      setTokens(trackedTokens);
      setSupportedTokens(supported);

      if (data.walletAddress && chainResult.evmChains.length > 0) {
        fetchBalances(data.walletAddress, chainResult.evmChains);
      }
    } catch (error) {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "Failed to load wallet",
        error,
        { component: "useOrgWallet" }
      );
      setWalletData({ hasWallet: false });
      setWalletLoading(false);
    }
  }, [refreshSafes, fetchBalances]);

  const handleAddToken = useCallback(
    async (chainId: number, tokenAddress: string): Promise<void> => {
      const symbol = await addTrackedToken(chainId, tokenAddress);
      toast.success(`Added ${symbol} to tracked tokens`);
      await loadWallet();
    },
    [loadWallet]
  );

  const handleRemoveToken = useCallback(
    async (tokenId: string, symbol: string): Promise<void> => {
      try {
        await removeTrackedToken(tokenId);
        toast.success(`Removed ${symbol} from tracked tokens`);
        await loadWallet();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to remove token"
        );
      }
    },
    [loadWallet]
  );

  const handleCreateWallet = useCallback(
    async (email: string): Promise<void> => {
      await createWallet(email);
      toast.success("Wallet created successfully!");
      await loadWallet();
      invalidateWalletInfo();
    },
    [loadWallet, invalidateWalletInfo]
  );

  const buildAssets = useCallback(
    (): WithdrawableAsset[] =>
      buildWithdrawableAssets({
        balances,
        chains,
        supportedTokenBalances,
        supportedTokens,
        tokenBalances,
        tokens,
      }),
    [
      balances,
      chains,
      supportedTokenBalances,
      supportedTokens,
      tokenBalances,
      tokens,
    ]
  );

  const handleWithdraw = useCallback(
    (chainId: number, tokenAddress?: string): void => {
      if (!walletData?.walletAddress) {
        return;
      }
      const assets = buildAssets();
      if (assets.length === 0) {
        toast.error("No assets available for withdrawal");
        return;
      }
      push(WithdrawModal, {
        assets,
        walletAddress: walletData.walletAddress,
        initialAssetIndex: findAssetIndex(assets, chainId, tokenAddress),
      });
    },
    [walletData?.walletAddress, buildAssets, push]
  );

  const sessionUserId = session?.user?.id;
  // The wallet, its Safes and every balance are organization-scoped, so the
  // active org is a fetch key just like the signed-in user. Without it,
  // switching organization leaves the previous org's accounts on screen.
  const activeOrgId = activeOrg?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionUserId and activeOrgId are refetch triggers
  useEffect(() => {
    loadWallet();
  }, [loadWallet, sessionUserId, activeOrgId]);

  return {
    balances,
    buildAssets,
    chains,
    fetchSafes: refreshSafes,
    handleAddToken,
    handleCreateWallet,
    handleRemoveToken,
    handleWithdraw,
    isLoadingBalances,
    loadWallet,
    safes,
    setSafes,
    solanaIsTestnet,
    supportedTokenBalances,
    supportedTokens,
    tokenBalances,
    tokens,
    walletData,
    walletLoading,
  };
}
