"use client";

import { Search, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { type HubTabValue, isHubTabValue } from "@/app/hub/_tabs-shared";

// Phase 44 plan 44-09: tab-strip search input. Per UI-SPEC §1 + §Open
// Issues #3 recommendation, ship the visual + per-active-tab placeholder
// now. The onChange handler holds local state but is intentionally NOT
// wired to the per-tab filters in Phase 44:
//
//   - Workflows tab: existing Phase-43 search lives inside the Workflows
//     client island (`app/hub/_view-shell.tsx` `searchQuery` useState).
//     Rewiring through the RSC ↔ client boundary requires either lifting
//     state into a shared client provider or piping a Zustand store —
//     both are out of scope for this wave.
//   - Protocols / Marketplace tabs: server-rendered, no client-side
//     search wiring exists yet. Adding `?q=` to the marketplace cache key
//     and a client filter to the protocols grid are explicit follow-ups.
//
// Cross-tab UNIFIED search (single input that searches across all three
// surfaces simultaneously) is deferred per UI-SPEC §Open Issues #3 and
// CONTEXT.md `Deferred Ideas`. The visual + dynamic placeholder ship now
// so the tab-strip layout is complete; the functional wiring comes in a
// follow-up sub-phase.

const PLACEHOLDERS: Record<HubTabValue, string> = {
  protocols: "Search protocols…",
  workflows: "Search templates…",
  marketplace: "Search marketplace…",
};

const DEFAULT_TAB: HubTabValue = "protocols";

function readActiveTab(value: string | null): HubTabValue {
  if (value === null) {
    return DEFAULT_TAB;
  }
  const lower = value.trim().toLowerCase();
  return isHubTabValue(lower) ? lower : DEFAULT_TAB;
}

export function HubTabSearch(): React.ReactElement {
  const searchParams = useSearchParams();
  const activeTab = readActiveTab(searchParams.get("tab"));
  const [value, setValue] = useState("");
  const placeholder = PLACEHOLDERS[activeTab];

  return (
    <div className="flex min-w-[240px] max-w-sm flex-1 items-center gap-2 rounded-lg border border-border/60 bg-[var(--color-hub-icon-bg)] px-3.5 py-2 transition-colors focus-within:border-[var(--color-text-accent)]/40 focus-within:ring-1 focus-within:ring-[var(--color-text-accent)]/20 motion-reduce:transition-none">
      <Search
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
      <label className="sr-only" htmlFor="hub-tab-search">
        Search the active tab
      </label>
      <input
        className="h-5 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
        id="hub-tab-search"
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
      {value && (
        <button
          aria-label="Clear search"
          className="text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
          onClick={() => setValue("")}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
