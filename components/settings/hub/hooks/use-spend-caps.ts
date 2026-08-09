"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSettingsContext } from "../settings-context";

export const EVM_DECIMALS = 18;
export const SOLANA_DECIMALS = 9;

type SpendCapResponse = {
  dailyCapWei: string | null;
  dailyUsedWei: string;
  dailySolanaCapLamports: string | null;
  dailySolanaUsedLamports: string;
};

export type SpendCap = {
  id: "evm" | "solana";
  label: string;
  symbol: string;
  decimals: number;
  cap: string | null;
  used: string;
};

export type SpendCapsState = {
  caps: SpendCap[];
  loading: boolean;
  saving: boolean;
  save: (id: "evm" | "solana", base: string | null) => Promise<void>;
};

const FIELD: Record<"evm" | "solana", string> = {
  evm: "dailyValueCapWei",
  solana: "dailySolanaValueCapLamports",
};

export function useSpendCaps(): SpendCapsState {
  const { revision } = useSettingsContext();
  const [data, setData] = useState<SpendCapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback((): void => {
    setLoading(true);
    fetch("/api/analytics/spend-cap")
      .then((res) => (res.ok ? res.json() : null))
      .then((next: SpendCapResponse | null) => setData(next))
      .catch(() => toast.error("Could not load the spend caps"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, revision]);

  const save = useCallback(
    async (id: "evm" | "solana", base: string | null): Promise<void> => {
      setSaving(true);
      try {
        const res = await fetch("/api/analytics/spend-cap", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [FIELD[id]]: base }),
        });
        if (res.ok) {
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  ...(id === "evm"
                    ? { dailyCapWei: base }
                    : { dailySolanaCapLamports: base }),
                }
              : prev
          );
          toast.success(base ? "Cap saved" : "Cap cleared");
          return;
        }
        toast.error(
          res.status === 403
            ? "Only organization owners and admins can change the cap"
            : "Could not save the cap"
        );
      } catch {
        toast.error("Could not save the cap");
      } finally {
        setSaving(false);
      }
    },
    []
  );

  return {
    caps: [
      {
        cap: data?.dailyCapWei ?? null,
        decimals: EVM_DECIMALS,
        id: "evm",
        label: "EVM networks",
        symbol: "ETH",
        used: data?.dailyUsedWei ?? "0",
      },
      {
        cap: data?.dailySolanaCapLamports ?? null,
        decimals: SOLANA_DECIMALS,
        id: "solana",
        label: "Solana",
        symbol: "SOL",
        used: data?.dailySolanaUsedLamports ?? "0",
      },
    ],
    loading,
    saving,
    save,
  };
}
