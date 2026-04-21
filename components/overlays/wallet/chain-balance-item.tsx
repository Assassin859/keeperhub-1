"use client";

import {
  ChevronDown,
  Copy,
  ExternalLink,
  Plus,
  SendHorizontal,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toChecksumAddress } from "@/lib/address-utils";
import type {
  ChainBalance,
  ChainData,
  SupportedTokenBalance,
  TokenBalance,
} from "@/lib/wallet/types";
import {
  hasIndependentTokenList,
  isTempoChain,
  MAINNET_CHAIN_ID,
} from "./chain-utils";

function ChainBalanceDisplay({
  balance,
}: {
  balance: ChainBalance;
}): React.ReactElement {
  if (balance.loading) {
    return <div className="mt-1 text-muted-foreground text-xs">Loading...</div>;
  }
  if (balance.error) {
    return <div className="mt-1 text-destructive text-xs">{balance.error}</div>;
  }
  return (
    <div className="mt-1 text-muted-foreground text-xs">
      {balance.balance} {balance.symbol}
    </div>
  );
}

function buildTokenExplorerUrl(
  chain: ChainData | undefined,
  tokenAddress: string
): string | null {
  if (!chain?.explorerUrl) {
    return null;
  }
  const path = chain.explorerAddressPath || "/address/{address}";
  return `${chain.explorerUrl}${path.replace("{address}", tokenAddress)}`;
}

type TokenItemProps = {
  token: SupportedTokenBalance | TokenBalance;
  isAdmin: boolean;
  isCustom?: boolean;
  customExplorerUrl?: string | null;
  onDelete?: (tokenId: string, symbol: string) => void;
  onWithdraw: (chainId: number, tokenAddress: string) => void;
};

function TokenItemWithActions({
  token,
  isAdmin,
  isCustom,
  customExplorerUrl,
  onDelete,
  onWithdraw,
}: TokenItemProps): React.ReactElement {
  const isSupportedToken = (
    t: SupportedTokenBalance | TokenBalance
  ): t is SupportedTokenBalance => "logoUrl" in t;

  const supportedToken = isSupportedToken(token) ? token : null;
  const customToken = isSupportedToken(token) ? null : token;

  const isUnavailable = supportedToken?.available === false;
  const numBalance = Number.parseFloat(token.balance);
  const hasBalance = Number.isFinite(numBalance) && numBalance > 0;

  const tokenAddress =
    supportedToken?.tokenAddress || customToken?.tokenAddress;
  const explorerUrl = supportedToken?.explorerUrl || customExplorerUrl;

  const copyTokenAddress = (): void => {
    if (tokenAddress) {
      navigator.clipboard.writeText(toChecksumAddress(tokenAddress));
      toast.success("Token address copied");
    }
  };

  const renderBalance = (): React.ReactNode => {
    if (isUnavailable) {
      return <span className="italic">Not available</span>;
    }
    if (token.loading) {
      return <Spinner className="h-3 w-3" />;
    }
    if (token.error) {
      return <span className="text-destructive">{token.error}</span>;
    }
    return `${token.balance} ${token.symbol}`;
  };

  return (
    <div
      className={`flex items-center gap-2 py-1.5 ${isUnavailable ? "opacity-50" : ""}`}
    >
      {supportedToken?.logoUrl && (
        <Image
          alt={token.symbol}
          className={`h-4 w-4 rounded-full ${isUnavailable ? "grayscale" : ""}`}
          height={16}
          src={supportedToken.logoUrl}
          width={16}
        />
      )}
      {!supportedToken?.logoUrl && (
        <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted font-medium text-[10px]">
          $
        </div>
      )}
      <span className="font-medium text-xs">{token.symbol}</span>
      {!isUnavailable && tokenAddress && (
        <div className="flex items-center gap-1">
          <button
            aria-label="Copy token address"
            className="text-muted-foreground hover:text-foreground"
            onClick={copyTokenAddress}
            type="button"
          >
            <Copy className="h-3 w-3" />
          </button>
          {explorerUrl && (
            <a
              className="text-muted-foreground hover:text-foreground"
              href={explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
              title="View on explorer"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
      {isAdmin && isCustom && customToken && onDelete && (
        <Button
          className="ml-auto h-6 w-6"
          onClick={() => onDelete(customToken.tokenId, customToken.symbol)}
          size="icon"
          title="Remove token"
          variant="ghost"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground" />
        </Button>
      )}
      <span
        className={`text-muted-foreground text-xs ${
          isAdmin && isCustom ? "" : "ml-auto"
        }`}
      >
        {renderBalance()}
      </span>
      {isAdmin &&
        hasBalance &&
        !token.loading &&
        !isUnavailable &&
        tokenAddress && (
          <Button
            className="h-6 px-2 text-xs"
            onClick={() => onWithdraw(token.chainId, tokenAddress)}
            size="sm"
            variant="ghost"
          >
            <SendHorizontal className="h-3 w-3" />
          </Button>
        )}
    </div>
  );
}

function AddTokenRow({
  chainId,
  onAdd,
}: {
  chainId: number;
  onAdd: (chainId: number, tokenAddress: string) => Promise<void>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = (): void => {
    setOpen(false);
    setValue("");
  };

  const handleSubmit = async (): Promise<void> => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    // EIP-55 normalise before sending so the server receives a canonical
    // checksummed address. Falls back to the raw input if it isn't a valid
    // hex address so the server can return a clearer validation error.
    const address = toChecksumAddress(trimmed);
    setSubmitting(true);
    try {
      await onAdd(chainId, address);
      reset();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to add token"
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <div className="mt-2 flex justify-end">
        <Button
          className="h-7 px-2 text-muted-foreground text-xs hover:text-foreground"
          onClick={() => setOpen(true)}
          size="sm"
          variant="ghost"
        >
          <Plus className="h-3 w-3" />
          Add token
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <Input
        autoFocus
        className="h-7 flex-1 truncate font-mono !text-xs placeholder:text-xs focus-visible:ring-0 focus-visible:ring-offset-0 md:!text-xs"
        disabled={submitting}
        onChange={(e) => {
          const next = e.target.value;
          // Auto-checksum once the value is a complete 0x + 40 hex chars.
          // Keeps partial/typed input untouched so the caret doesn't jitter.
          if (/^0x[a-fA-F0-9]{40}$/.test(next)) {
            setValue(toChecksumAddress(next));
          } else {
            setValue(next);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleSubmit();
          } else if (e.key === "Escape") {
            reset();
          }
        }}
        placeholder="0x token contract"
        value={value}
      />
      <Button
        className="h-7 px-2 text-xs"
        disabled={submitting}
        onClick={reset}
        size="sm"
        variant="ghost"
      >
        Cancel
      </Button>
      <Button
        className="h-7 px-2 text-xs"
        disabled={submitting || !value.trim()}
        onClick={handleSubmit}
        size="sm"
      >
        {submitting ? <Spinner className="h-3 w-3" /> : "Add"}
      </Button>
    </div>
  );
}

export type ChainBalanceItemProps = {
  balance: ChainBalance;
  chain: ChainData | undefined;
  /** True once balances are loaded and this chain has a positive balance. */
  hasAnyBalance: boolean;
  /** True while balances are still being fetched; keep items folded. */
  isLoadingBalances: boolean;
  isAdmin: boolean;
  onAddToken: (chainId: number, tokenAddress: string) => Promise<void>;
  onRemoveToken: (tokenId: string, symbol: string) => void;
  onWithdraw: (chainId: number, tokenAddress?: string) => void;
  supportedTokenBalances: SupportedTokenBalance[];
  tokenBalances: TokenBalance[];
};

export function ChainBalanceItem({
  balance,
  chain,
  hasAnyBalance,
  isLoadingBalances,
  isAdmin,
  onAddToken,
  onRemoveToken,
  onWithdraw,
  supportedTokenBalances,
  tokenBalances,
}: ChainBalanceItemProps): React.ReactElement {
  // Auto-expand once loading completes and the chain has a balance. Folded by
  // default and during fetch. Null means "follow auto"; once the user toggles
  // manually we stick with their choice.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const autoOpen = !isLoadingBalances && hasAnyBalance;
  const isOpen = userToggled ?? autoOpen;

  // Skip the Radix open/close animation on first paint: when an item mounts
  // already open (e.g. switching Mainnets → Testnets for a chain that has a
  // balance) the 200ms slide makes it feel slow. Enable animations after the
  // initial render so later toggles still transition smoothly.
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const chainCustomTokens = tokenBalances.filter(
    (t) => t.chainId === balance.chainId
  );

  const isTempo = isTempoChain(balance.chainId);
  const isMainnet = balance.chainId === MAINNET_CHAIN_ID;
  const isIndependentTokenList = hasIndependentTokenList(balance.chainId);

  const chainSupportedTokens = (() => {
    if (isIndependentTokenList) {
      return supportedTokenBalances.filter(
        (t) => t.chainId === balance.chainId
      );
    }

    const mainnetTokens = supportedTokenBalances.filter(
      (t) => t.chainId === MAINNET_CHAIN_ID
    );

    if (isMainnet) {
      return mainnetTokens;
    }

    const chainTokensMap = new Map(
      supportedTokenBalances
        .filter((t) => t.chainId === balance.chainId)
        .map((t) => [t.symbol, t])
    );

    return mainnetTokens.map((mainnetToken) => {
      const chainToken = chainTokensMap.get(mainnetToken.symbol);
      if (chainToken) {
        return { ...chainToken, available: true };
      }
      return { ...mainnetToken, available: false, balance: "N/A" };
    });
  })();

  const nativeBalance = Number.parseFloat(balance.balance);
  const hasNativeBalance = Number.isFinite(nativeBalance) && nativeBalance > 0;

  const tokenSectionLabel =
    chainCustomTokens.length > 0 ? "Tokens" : "Stablecoins";

  const chevron = (
    <ChevronDown
      className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${
        isOpen ? "" : "-rotate-90"
      }`}
    />
  );

  const chainLabel = isTempo ? "TEMPO" : balance.name;

  const tokenList =
    chainSupportedTokens.length > 0 || chainCustomTokens.length > 0 ? (
      <div className="divide-y rounded border bg-background/50 px-2">
        {chainSupportedTokens.map((token) => (
          <TokenItemWithActions
            isAdmin={isAdmin}
            key={`supported-${token.chainId}-${token.tokenAddress}`}
            onWithdraw={onWithdraw}
            token={token}
          />
        ))}
        {chainCustomTokens.map((token) => (
          <TokenItemWithActions
            customExplorerUrl={buildTokenExplorerUrl(chain, token.tokenAddress)}
            isAdmin={isAdmin}
            isCustom
            key={`custom-${token.tokenId}`}
            onDelete={onRemoveToken}
            onWithdraw={onWithdraw}
            token={token}
          />
        ))}
      </div>
    ) : (
      <div className="text-muted-foreground text-xs">Loading tokens...</div>
    );

  return (
    <Collapsible
      className="rounded-lg border bg-muted/50 p-3"
      onOpenChange={(open) => setUserToggled(open)}
      open={isOpen}
    >
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger
          asChild
          className="flex flex-1 items-start gap-2 text-left"
        >
          <button type="button">
            <span className="mt-0.5">{chevron}</span>
            <span className="flex-1">
              <span className="flex items-center gap-1">
                <span className="font-medium text-sm">{chainLabel}</span>
              </span>
              {!isTempo && <ChainBalanceDisplay balance={balance} />}
            </span>
          </button>
        </CollapsibleTrigger>
        <div className="flex items-center gap-1">
          {balance.explorerUrl && (
            <a
              className="text-muted-foreground hover:text-foreground"
              href={balance.explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {!isTempo && isAdmin && hasNativeBalance && (
            <Button
              className="h-7 px-2 text-xs"
              onClick={() => onWithdraw(balance.chainId)}
              size="sm"
              variant="ghost"
            >
              <SendHorizontal className="h-3 w-3" />
              Withdraw
            </Button>
          )}
        </div>
      </div>
      <CollapsibleContent
        className={`overflow-hidden ${
          animate
            ? "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
            : ""
        }`}
      >
        <div className="mt-3">
          <div className="mb-1 font-medium text-muted-foreground text-xs">
            {tokenSectionLabel}
          </div>
          {tokenList}
          {isAdmin && (
            <AddTokenRow chainId={balance.chainId} onAdd={onAddToken} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
