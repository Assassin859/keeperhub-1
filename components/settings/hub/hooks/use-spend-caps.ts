"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useSettingsContext } from "../settings-context";
import { useCachedSection } from "./use-cached-section";

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
  const { organizationId } = useSettingsContext();
  const [saving, setSaving] = useState(false);
  const section = useCachedSection<SpendCapResponse | null>(
    organizationId ? `spend-caps:${organizationId}` : null,
    async () => {
      const res = await fetch("/api/analytics/spend-cap");
      return res.ok ? ((await res.json()) as SpendCapResponse) : null;
    }
  );
  const data = section.data ?? null;
  const loading = section.loading;
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
          // Read the saved value back rather than patching a copy, so the
          // cache other sections read from holds what the server has.
          await section.refetch();
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
