"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { truncateAddress } from "@/lib/address-utils";

const SOLANA_EXPLORER_BASE = "https://solscan.io";
const DEVNET_CHAIN_ID = 103;

type SolanaChainBalance = {
  chainId: number;
  chainName: string;
  isTestnet: boolean;
  balanceLamports: string;
  balanceSol: string;
  error: boolean;
};

function formatSol(sol: string): string {
  const n = Number(sol);
  if (!sol || Number.isNaN(n)) {
    return "-";
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
}

function solscanUrl(chainId: number, address: string): string {
  return chainId === DEVNET_CHAIN_ID
    ? `${SOLANA_EXPLORER_BASE}/account/${address}?cluster=devnet`
    : `${SOLANA_EXPLORER_BASE}/account/${address}`;
}

/**
 * Assets view for the Solana Turnkey EOA. Fetches the live native SOL balance
 * for each enabled Solana network from `/api/user/wallet/solana-balance`
 * (the EVM balance machinery does not apply to a base58 account).
 */
export function SolanaAssets({
  address,
}: {
  address: string;
}): React.ReactElement {
  const [balances, setBalances] = useState<SolanaChainBalance[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/wallet/solana-balance")
      .then((res) => res.json())
      .then((data: { balances?: SolanaChainBalance[] }) => {
        if (!cancelled) {
          setBalances(data.balances ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <div className="rounded-lg border bg-muted/20 p-4 text-muted-foreground text-sm">
        Could not load Solana balance.{" "}
        <a
          className="underline transition-colors hover:text-foreground"
          href={solscanUrl(0, address)}
          rel="noopener noreferrer"
          target="_blank"
        >
          View on Solscan
        </a>
      </div>
    );
  }

  if (balances === null) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (balances.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 p-4 text-muted-foreground text-sm">
        No Solana networks available for this account yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {balances.map((b) => (
        <div className="rounded-lg border bg-card p-3" key={b.chainId}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm">{b.chainName}</span>
            <span className="font-medium text-sm">
              {b.error ? "Unavailable" : formatSol(b.balanceSol)}
            </span>
          </div>
          <div className="mt-1 text-muted-foreground text-xs">
            <a
              className="font-mono transition-colors hover:text-foreground hover:underline"
              href={solscanUrl(b.chainId, address)}
              rel="noopener noreferrer"
              target="_blank"
            >
              {truncateAddress(address)}
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
