"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { POLICY_PERIOD_OPTIONS } from "./policy-token-row";

export type RoleAllowance = {
  id: string;
  protocolSlug: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  maxRefillWei: string;
  refillWei: string;
  periodSeconds: number;
  lastChainBalanceWei: string | null;
};

type Props = {
  allowance: RoleAllowance;
  safeId: string;
  isAdmin: boolean;
  onRevoked: () => Promise<void>;
};

function periodLabel(seconds: number): string {
  const match = POLICY_PERIOD_OPTIONS.find((o) => o.seconds === seconds);
  if (match) {
    return match.label.toLowerCase();
  }
  return `${seconds}s`;
}

function formatWei(amount: string, decimals: number): string {
  try {
    const big = BigInt(amount);
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = big / divisor;
    const remainder = big % divisor;
    const remainderStr = remainder
      .toString()
      .padStart(decimals, "0")
      .slice(0, 4);
    return `${whole.toString()}.${remainderStr}`;
  } catch {
    return amount;
  }
}

export function RoleAllowanceRow({
  allowance,
  safeId,
  isAdmin,
  onRevoked,
}: Props): React.ReactElement {
  const [revoking, setRevoking] = useState<boolean>(false);

  const handleRevoke = async (): Promise<void> => {
    setRevoking(true);
    try {
      const res = await fetch(
        `/api/user/safe/${safeId}/role/allowances/${allowance.tokenAddress}`,
        { method: "DELETE" }
      );
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Revoke failed");
        return;
      }
      toast.success(`Revoked ${allowance.tokenSymbol} allowance`);
      await onRevoked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setRevoking(false);
    }
  };

  const remaining = allowance.lastChainBalanceWei ?? allowance.maxRefillWei;
  const remainingHuman = formatWei(remaining, allowance.tokenDecimals);
  const capHuman = formatWei(allowance.maxRefillWei, allowance.tokenDecimals);

  return (
    <li className="flex items-center justify-between gap-3 rounded border bg-muted/20 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{allowance.tokenSymbol}</span>
          <span className="text-muted-foreground text-xs">
            {remainingHuman} / {capHuman} left
          </span>
        </div>
        <div className="text-muted-foreground text-xs">
          refills {periodLabel(allowance.periodSeconds)}
        </div>
      </div>
      {isAdmin && (
        <Button
          aria-label={`Revoke ${allowance.tokenSymbol} allowance`}
          disabled={revoking}
          onClick={handleRevoke}
          size="sm"
          type="button"
          variant="ghost"
        >
          {revoking ? <Spinner className="h-4 w-4" /> : "Revoke"}
        </Button>
      )}
    </li>
  );
}
