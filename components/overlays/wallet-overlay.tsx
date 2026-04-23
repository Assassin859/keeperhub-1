"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { buildWithdrawableAssets } from "@/lib/wallet/build-withdrawable-assets";
import { fetchAllSupportedTokenBalances } from "@/lib/wallet/fetch-balances";
import type {
  ChainData,
  SupportedToken,
  SupportedTokenBalance,
  TokenData,
  WalletData,
} from "@/lib/wallet/types";
import { useWalletBalances } from "@/lib/wallet/use-wallet-balances";
import { useInvalidateWalletInfo } from "@/lib/wallet/use-wallet-info";
import { BalancesTab } from "./wallet/balances-tab";
import { ManageTab } from "./wallet/manage-tab";
import { NoWalletSection } from "./wallet/no-wallet-section";
import { type WithdrawableAsset, WithdrawModal } from "./withdraw-modal";

type WalletTab = "balances" | "manage";

type WalletOverlayProps = {
  overlayId: string;
  initialTab?: WalletTab;
};

export function WalletOverlay({
  overlayId,
  initialTab = "balances",
}: WalletOverlayProps) {
  const { closeAll, push } = useOverlay();
  const { data: session } = useSession();
  const { isAdmin } = useActiveMember();
  const invalidateWalletInfo = useInvalidateWalletInfo();

  const [walletLoading, setWalletLoading] = useState(true);
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [chains, setChains] = useState<ChainData[]>([]);
  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [supportedTokens, setSupportedTokens] = useState<SupportedToken[]>([]);
  const [supportedTokenBalances, setSupportedTokenBalances] = useState<
    SupportedTokenBalance[]
  >([]);
  const [supportedBalancesLoading, setSupportedBalancesLoading] =
    useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [switchingWallet, setSwitchingWallet] = useState(false);
  // Controlled tab state so reload cycles (e.g. switching Para/Turnkey) don't
  // reset the user's active tab back to "balances".
  const [activeTab, setActiveTab] = useState<WalletTab>(initialTab);

  const {
    balances,
    tokenBalances,
    loading: nativeBalancesLoading,
    fetchBalances,
  } = useWalletBalances();
  const isLoadingBalances = nativeBalancesLoading || supportedBalancesLoading;

  const fetchChains = useCallback(async (): Promise<ChainData[]> => {
    try {
      const response = await fetch("/api/chains");
      const data: ChainData[] = await response.json();
      const evmChains = data.filter((chain) => chain.chainType === "evm");
      setChains(evmChains);
      return evmChains;
    } catch (error) {
      console.error("Failed to fetch chains:", error);
      return [];
    }
  }, []);

  const fetchTokens = useCallback(async (): Promise<TokenData[]> => {
    try {
      const response = await fetch("/api/user/wallet/tokens");
      const data = await response.json();
      setTokens(data.tokens || []);
      return data.tokens || [];
    } catch (error) {
      console.error("Failed to fetch tokens:", error);
      return [];
    }
  }, []);

  const fetchSupportedTokensData = useCallback(async (): Promise<
    SupportedToken[]
  > => {
    try {
      const response = await fetch("/api/supported-tokens");
      const data = await response.json();
      const tokenList = data.tokens || [];
      setSupportedTokens(tokenList);
      return tokenList;
    } catch (error) {
      console.error("Failed to fetch supported tokens:", error);
      return [];
    }
  }, []);

  const fetchSupportedBalances = useCallback(
    async (
      walletAddress: string,
      chainList: ChainData[],
      tokenList: SupportedToken[]
    ): Promise<void> => {
      if (tokenList.length === 0) {
        setSupportedTokenBalances([]);
        return;
      }

      setSupportedBalancesLoading(true);
      setSupportedTokenBalances(
        tokenList.map((token) => ({
          chainId: token.chainId,
          tokenAddress: token.tokenAddress,
          symbol: token.symbol,
          name: token.name,
          logoUrl: token.logoUrl,
          balance: "0",
          loading: true,
        }))
      );

      try {
        const results = await fetchAllSupportedTokenBalances(
          walletAddress,
          tokenList,
          chainList
        );
        setSupportedTokenBalances(results);
      } finally {
        setSupportedBalancesLoading(false);
      }
    },
    []
  );

  const loadWallet = useCallback(async () => {
    setWalletLoading(true);
    try {
      // Phase 1: Fetch wallet data first (fast - just address + email)
      const walletResponse = await fetch("/api/user/wallet");
      const data = await walletResponse.json();

      if (!data.hasWallet) {
        setWalletData({ hasWallet: false });
        setWalletLoading(false);
        return;
      }

      // Show wallet info immediately
      setWalletData(data);
      setWalletLoading(false);

      // Phase 2: Fetch chains/tokens in background
      const [chainList, tokenList, supportedList] = await Promise.all([
        fetchChains(),
        fetchTokens(),
        fetchSupportedTokensData(),
      ]);

      // Phase 3: Fetch balances (they show loading states internally)
      if (data.walletAddress && chainList.length > 0) {
        fetchBalances(data.walletAddress, chainList, tokenList);
        fetchSupportedBalances(data.walletAddress, chainList, supportedList);
      }
    } catch (error) {
      console.error("Failed to load wallet:", error);
      setWalletData({ hasWallet: false });
      setWalletLoading(false);
    }
  }, [
    fetchChains,
    fetchTokens,
    fetchSupportedTokensData,
    fetchBalances,
    fetchSupportedBalances,
  ]);

  const handleRefresh = useCallback(async () => {
    if (!(walletData?.walletAddress && chains.length > 0)) {
      return;
    }
    setRefreshing(true);
    await Promise.all([
      fetchBalances(walletData.walletAddress, chains, tokens),
      fetchSupportedBalances(walletData.walletAddress, chains, supportedTokens),
    ]);
    setRefreshing(false);
  }, [
    walletData?.walletAddress,
    chains,
    tokens,
    supportedTokens,
    fetchBalances,
    fetchSupportedBalances,
  ]);

  const handleAddToken = async (
    chainId: number,
    tokenAddress: string
  ): Promise<void> => {
    const response = await fetch("/api/user/wallet/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId, tokenAddress }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to add token");
    }

    toast.success(`Added ${data.token.symbol} to tracked tokens`);
    await loadWallet();
  };

  const handleRemoveToken = async (
    tokenId: string,
    symbol: string
  ): Promise<void> => {
    try {
      const response = await fetch("/api/user/wallet/tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to remove token");
      }

      toast.success(`Removed ${symbol} from tracked tokens`);
      await loadWallet();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove token"
      );
    }
  };

  const handleCreateWallet = async (email: string): Promise<void> => {
    const response = await fetch("/api/user/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    const data: { error?: string } = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to create wallet");
    }

    toast.success("Wallet created successfully!");
    await loadWallet();
    invalidateWalletInfo();
  };

  const handleSelectActiveWallet = useCallback(
    async (walletId: string): Promise<void> => {
      setSwitchingWallet(true);
      try {
        const response = await fetch("/api/user/wallet/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletId }),
        });
        const data: { error?: string } = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Failed to switch active wallet");
        }
        toast.success("Active wallet updated");
        await loadWallet();
        invalidateWalletInfo();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to switch wallet"
        );
      } finally {
        setSwitchingWallet(false);
      }
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

  const findAssetIndex = useCallback(
    (
      assets: WithdrawableAsset[],
      chainId: number,
      tokenAddress?: string
    ): number => {
      if (tokenAddress) {
        const idx = assets.findIndex(
          (a) => a.chainId === chainId && a.tokenAddress === tokenAddress
        );
        return idx >= 0 ? idx : 0;
      }
      const idx = assets.findIndex(
        (a) => a.chainId === chainId && a.type === "native"
      );
      return idx >= 0 ? idx : 0;
    },
    []
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

      const initialIndex = findAssetIndex(assets, chainId, tokenAddress);
      push(WithdrawModal, {
        assets,
        walletAddress: walletData.walletAddress,
        initialAssetIndex: initialIndex,
      });
    },
    [walletData?.walletAddress, buildAssets, findAssetIndex, push]
  );

  // Re-fetch wallet when session changes (e.g., user signs in)
  const sessionUserId = session?.user?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionUserId is intentionally included to trigger re-fetch on sign-in
  useEffect(() => {
    loadWallet();
  }, [loadWallet, sessionUserId]);

  const description = walletData?.hasWallet
    ? "View your organization's wallet address and balances across different chains"
    : "Create a wallet for your organization to use in workflows";

  return (
    <Overlay
      actions={[{ label: "Done", onClick: closeAll }]}
      overlayId={overlayId}
      title="Organization Wallet"
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">{description}</p>

      {walletLoading && (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      )}

      {!walletLoading && walletData?.hasWallet && (
        <Tabs
          className="w-full"
          onValueChange={(value) => setActiveTab(value as WalletTab)}
          value={activeTab}
        >
          <TabsList className="w-full">
            <TabsTrigger value="balances">Balances</TabsTrigger>
            <TabsTrigger value="manage">Manage</TabsTrigger>
          </TabsList>
          <TabsContent className="mt-4" value="balances">
            <BalancesTab
              balances={balances}
              chains={chains}
              isAdmin={isAdmin}
              isLoadingBalances={isLoadingBalances}
              onAddToken={handleAddToken}
              onRefresh={handleRefresh}
              onRemoveToken={handleRemoveToken}
              onWithdraw={handleWithdraw}
              refreshing={refreshing}
              supportedTokenBalances={supportedTokenBalances}
              tokenBalances={tokenBalances}
            />
          </TabsContent>
          <TabsContent className="mt-4 space-y-4" value="manage">
            {walletData.email && walletData.walletAddress && (
              <ManageTab
                canExportKey={!!walletData.canExportKey}
                email={walletData.email}
                isAdmin={isAdmin}
                isOwner={!!walletData.isOwner}
                onSelectActiveWallet={handleSelectActiveWallet}
                switchingWallet={switchingWallet}
                walletAddress={walletData.walletAddress}
                wallets={walletData.wallets}
              />
            )}
          </TabsContent>
        </Tabs>
      )}

      {!(walletLoading || walletData?.hasWallet) && (
        <NoWalletSection
          initialEmail={session?.user?.email ?? ""}
          isAdmin={isAdmin}
          onCreateWallet={handleCreateWallet}
        />
      )}
    </Overlay>
  );
}
