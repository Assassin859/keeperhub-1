"use client";

import { Check, ChevronDown } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type React from "react";
import { useTransition } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MarketplaceSort } from "@/lib/marketplace/leaderboard-query";

type SortUiValue = Extract<MarketplaceSort, "popular" | "newest">;

type SortUiOption = {
  value: SortUiValue;
  label: string;
};

// UI-VISIBLE options ONLY. The third API value `top-calls` is intentionally
// excluded from the dropdown (UI-SPEC Open Issues #2) - it is an agent-facing
// alias for `popular` and showing both confuses humans. Revenue-based sort is
// EXPLICITLY DEFERRED per MARKET-02 + MARKET-FUTURE-01 (privacy review pending).
const SORT_OPTIONS: readonly SortUiOption[] = [
  { value: "popular", label: "Popular" },
  { value: "newest", label: "Newest" },
] as const;

type Props = {
  active: MarketplaceSort;
};

function uiLabelFor(active: MarketplaceSort): string {
  // Map the API alias `top-calls` to the UI label `Popular` (they sort identically).
  if (active === "top-calls") {
    return "Popular";
  }
  const option = SORT_OPTIONS.find((opt) => opt.value === active);
  return option?.label ?? "Popular";
}

export function MarketplaceSortDropdown({ active }: Props): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const handleSelect = (value: SortUiValue): void => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "marketplace");
    params.set("sort", value);
    // Reset cursor when sort changes - page 2 of `popular` does not apply to `newest`.
    params.delete("cursor");
    startTransition(() => {
      router.replace(`/hub?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Sort marketplace by"
        className="inline-flex h-9 items-center gap-2 rounded-md border border-border/40 bg-[var(--color-hub-icon-bg)] px-3 font-normal text-foreground text-sm transition-colors hover:bg-[var(--color-hub-icon-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] motion-reduce:transition-none"
        type="button"
      >
        Sort: {uiLabelFor(active)}
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[160px] rounded-md border border-border/30 bg-[var(--color-hub-card)] p-1 shadow-md"
      >
        {SORT_OPTIONS.map((option) => {
          const isActive =
            option.value === active ||
            (option.value === "popular" && active === "top-calls");
          return (
            <DropdownMenuItem
              aria-checked={isActive}
              className={
                isActive
                  ? "flex cursor-pointer items-center justify-between rounded-sm px-3 py-1.5 font-semibold text-[var(--color-text-accent)] text-sm hover:bg-[var(--color-hub-icon-bg)] focus-visible:bg-[var(--color-hub-icon-bg)] focus-visible:outline-none"
                  : "flex cursor-pointer items-center justify-between rounded-sm px-3 py-1.5 font-normal text-muted-foreground text-sm hover:bg-[var(--color-hub-icon-bg)] hover:text-foreground focus-visible:bg-[var(--color-hub-icon-bg)] focus-visible:text-foreground focus-visible:outline-none"
              }
              key={option.value}
              onSelect={() => handleSelect(option.value)}
              role="menuitemradio"
            >
              {option.label}
              {isActive && (
                <Check
                  aria-hidden="true"
                  className="size-3.5 text-[var(--color-text-accent)]"
                />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
