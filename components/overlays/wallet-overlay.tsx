"use client";

import { ChevronLeftIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { DeploySafeCard } from "@/components/safe/deploy-safe-card";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { buildWithdrawableAssets } from "@/lib/wallet/build-withdrawable-assets";
import type {
  ChainData,
  SupportedToken,
  TokenData,
  WalletData,
} from "@/lib/wallet/types";
import { useWalletBalances } from "@/lib/wallet/use-wallet-balances";
import { useInvalidateWalletInfo } from "@/lib/wallet/use-wallet-info";
import { BalancesTab } from "./wallet/balances-tab";
import { ManageTab } from "./wallet/manage-tab";
import { NoWalletSection } from "./wallet/no-wallet-section";
import { type WithdrawableAsset, WithdrawModal } from "./withdraw-modal";

type WalletTab = "balances" | "manage" | "safe";

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
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<WalletTab>(initialTab);

  const {
    balances,
    tokenBalances,
    supportedTokenBalances,
    loading: isLoadingBalances,
    fetchBalances,
  } = useWalletBalances();

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

      // Phase 2: Fetch chains/tokens metadata in parallel. The chain list is
      // used for explorer links and the manage tab; tokens / supportedTokens
      // power the manage UI. Balances are fetched server-side below.
      const [chainList] = await Promise.all([
        fetchChains(),
        fetchTokens(),
        fetchSupportedTokensData(),
      ]);

      // Phase 3: Fetch native + tracked + supported balances from the
      // server-side endpoint (provider URLs never reach the browser).
      if (data.walletAddress && chainList.length > 0) {
        fetchBalances(data.walletAddress, chainList);
      }
    } catch (error) {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "Failed to load wallet",
        error,
        { component: "WalletOverlay" }
      );
      setWalletData({ hasWallet: false });
      setWalletLoading(false);
    }
  }, [fetchChains, fetchTokens, fetchSupportedTokensData, fetchBalances]);

  const handleRefresh = useCallback(async () => {
    if (!(walletData?.walletAddress && chains.length > 0)) {
      return;
    }
    setRefreshing(true);
    await fetchBalances(walletData.walletAddress, chains);
    setRefreshing(false);
  }, [walletData?.walletAddress, chains, fetchBalances]);

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
                isOwner={!!walletData.isOwner}
                onOpenSafeView={() => setActiveTab("safe")}
                walletAddress={walletData.walletAddress}
              />
            )}
          </TabsContent>
          <TabsContent className="mt-4 space-y-4" value="safe">
            <button
              className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
              onClick={() => setActiveTab("manage")}
              type="button"
            >
              <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
              Back to Manage
            </button>
            <DeploySafeCard isAdmin={!!walletData.isOwner} />
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
