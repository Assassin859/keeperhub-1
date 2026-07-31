"use client";

import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PayPerExecutionPreview } from "@/components/welcome/previews";
import { WelcomeShell } from "@/components/welcome/welcome-shell";
import { toChecksumAddress } from "@/lib/address-utils";
import { BILLING_API } from "@/lib/billing/constants";
import { PAYG_DEFAULT_CHAIN_ID } from "@/lib/billing/payg/constants";

const NEXT_PATH = "/welcome/connect-agent";
const BACK_PATH = "/welcome/invite-members";
const BASE_CHAIN_ID = 8453;

type PaygStatus = {
  enabled: boolean;
  priceUsdc: string;
  treasuryConfigured: boolean;
  chainId: number;
};

type TokenBalance = { symbol: string; balance: string };

type ChainBalance = {
  chainId: number;
  supportedTokens: TokenBalance[];
  tokens: TokenBalance[];
};

type BalancesResponse = {
  walletAddress: string;
  balances: ChainBalance[];
};

function formatUsdc(amount: string | undefined): string {
  const value = Number.parseFloat(amount ?? "0");
  if (!Number.isFinite(value)) {
    return "$0.00 USDC";
  }
  return `$${value.toFixed(2)} USDC`;
}

function findUsdcBalance(
  balances: ChainBalance[],
  chainId: number
): string | undefined {
  const chain = balances.find((b) => b.chainId === chainId);
  if (!chain) {
    return undefined;
  }
  const pool =
    chain.supportedTokens.length > 0 ? chain.supportedTokens : chain.tokens;
  return pool.find((t) => t.symbol.toUpperCase() === "USDC")?.balance;
}

/** Highlighted callout for the free-tier execution cap, the headline of this step. */
function FreeCapCallout({
  priceLabel,
}: {
  priceLabel: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-keeperhub-green/20 bg-keeperhub-green/5 p-4">
      <p className="font-semibold text-4xl text-keeperhub-green tabular-nums">
        5,000
      </p>
      <div className="flex flex-col gap-0.5">
        <p className="font-medium text-foreground text-sm">
          Free executions included every month
        </p>
        <p className="text-muted-foreground text-xs">
          Then {priceLabel} per execution in USDC, gasless.
        </p>
      </div>
    </div>
  );
}

/** Funding wallet card: prominent USDC balance plus the checksummed address. */
function FundingWalletCard({
  balanceLoading,
  usdcBalance,
  checksummedAddress,
  explorerUrl,
  onCopy,
}: {
  balanceLoading: boolean;
  usdcBalance: string | undefined;
  checksummedAddress: string | null;
  explorerUrl: string | null;
  onCopy: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Funding wallet
      </p>
      <p className="font-semibold text-foreground text-xl">
        {balanceLoading ? "Loading balance..." : formatUsdc(usdcBalance)}
      </p>
      {checksummedAddress ? (
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <code className="break-all font-mono">{checksummedAddress}</code>
          <button
            aria-label="Copy funding address"
            className="hover:text-foreground"
            onClick={onCopy}
            type="button"
          >
            <Copy className="size-3" />
          </button>
          {explorerUrl ? (
            <a
              aria-label="View on Basescan"
              className="hover:text-foreground"
              href={explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Enable button, "Enabled" badge, or a muted note, depending on payg status. */
function EnableAction({
  available,
  status,
  enabling,
  onEnable,
}: {
  available: boolean;
  status: PaygStatus | null;
  enabling: boolean;
  onEnable: () => void;
}): React.ReactElement | null {
  if (!available) {
    return null;
  }
  if (status?.enabled) {
    return (
      <Badge
        className="w-fit border-keeperhub-green/30 bg-keeperhub-green/10 text-keeperhub-green"
        variant="outline"
      >
        Enabled
      </Badge>
    );
  }
  if (!status?.treasuryConfigured) {
    return (
      <p className="text-muted-foreground text-xs">Available in production.</p>
    );
  }
  return (
    <Button
      className="w-fit"
      disabled={enabling}
      onClick={onEnable}
      size="sm"
      type="button"
      variant="outline"
    >
      {enabling ? <Loader2 className="size-3.5 animate-spin" /> : null}
      Enable pay-as-you-go
    </Button>
  );
}

/** Wizard step 3: introduce the free + pay-as-you-go plan and fund the wallet. */
export function PayPerExecutionStep(): React.ReactElement {
  const router = useRouter();
  const [payg, setPayg] = useState<PaygStatus | null>(null);
  const [paygAvailable, setPaygAvailable] = useState(true);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [balances, setBalances] = useState<ChainBalance[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadPayg = async (): Promise<void> => {
      try {
        const res = await fetch(BILLING_API.PAYG, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) {
            setPaygAvailable(false);
          }
          return;
        }
        const data = (await res.json()) as PaygStatus;
        if (!cancelled) {
          setPayg(data);
        }
      } catch {
        if (!cancelled) {
          setPaygAvailable(false);
        }
      }
    };
    loadPayg().catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadBalances = async (): Promise<void> => {
      try {
        const res = await fetch("/api/user/wallet/balances", {
          cache: "no-store",
        });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as BalancesResponse;
        if (!cancelled) {
          setWalletAddress(data.walletAddress);
          setBalances(data.balances);
        }
      } catch {
        // Balance stays unknown; the funding block shows a loading fallback.
      } finally {
        if (!cancelled) {
          setBalanceLoading(false);
        }
      }
    };
    loadBalances().catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);

  const chainId = payg?.chainId ?? PAYG_DEFAULT_CHAIN_ID;
  const usdcBalance = findUsdcBalance(balances, chainId);
  const checksummedAddress = walletAddress
    ? toChecksumAddress(walletAddress)
    : null;
  const priceLabel = payg?.priceUsdc
    ? `$${Number.parseFloat(payg.priceUsdc).toFixed(2)}`
    : "$0.01";
  const explorerUrl =
    checksummedAddress && chainId === BASE_CHAIN_ID
      ? `https://basescan.org/address/${checksummedAddress}`
      : null;

  const handleCopy = (): void => {
    if (!checksummedAddress) {
      return;
    }
    navigator.clipboard
      .writeText(checksummedAddress)
      .then(() => toast.success("Address copied"))
      .catch(() => undefined);
  };

  const handleEnable = (): void => {
    setEnabling(true);
    fetch(BILLING_API.PAYG, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(data.error ?? "Could not enable pay-as-you-go");
          return;
        }
        const data = (await res.json()) as PaygStatus;
        setPayg(data);
        toast.success("Pay-as-you-go enabled");
      })
      .catch((error: unknown) => {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not enable pay-as-you-go"
        );
      })
      .finally(() => setEnabling(false));
  };

  return (
    <WelcomeShell
      description="Every organization gets 5,000 free executions a month. Turn on pay-as-you-go to keep workflows running past the free tier."
      nextLabel="Continue"
      onBack={() => router.push(BACK_PATH)}
      onNext={() => router.push(NEXT_PATH)}
      onSkip={() => router.push(NEXT_PATH)}
      preview={
        <PayPerExecutionPreview
          enabled={payg?.enabled ?? false}
          priceLabel={priceLabel}
        />
      }
      stepIndex={2}
      title="Pay per execution"
    >
      <div className="flex flex-col gap-5">
        <FreeCapCallout priceLabel={priceLabel} />

        <ul className="list-disc space-y-1 pl-4 text-muted-foreground text-sm">
          <li>
            Charges are gasless USDC pulled straight from your organization
            wallet. No card required.
          </li>
          <li>Spending caps and top-ups are always available in Billing.</li>
        </ul>

        <FundingWalletCard
          balanceLoading={balanceLoading}
          checksummedAddress={checksummedAddress}
          explorerUrl={explorerUrl}
          onCopy={handleCopy}
          usdcBalance={usdcBalance}
        />

        <EnableAction
          available={paygAvailable}
          enabling={enabling}
          onEnable={handleEnable}
          status={payg}
        />

        <p className="text-muted-foreground text-xs">
          Optional now. You can enable pay-as-you-go, set spending caps, and top
          up anytime in Billing.
        </p>
      </div>
    </WelcomeShell>
  );
}
