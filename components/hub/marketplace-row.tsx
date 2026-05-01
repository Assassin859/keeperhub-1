"use client";

import type { MarketplaceLeaderboardRow } from "@/lib/marketplace/leaderboard-query";

type MarketplaceRowProps = {
  row: MarketplaceLeaderboardRow;
  rank: number;
};

function priceLabel(raw: string | null): string {
  if (raw === null || raw === "") {
    return "—";
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return "—";
  }
  return `$${num.toFixed(2)}/call`;
}

function callCountLabel(count: number): string {
  return count.toLocaleString("en-US");
}

type ChainBadge = { label: string; isBase: boolean } | null;

function chainBadge(chain: string | null): ChainBadge {
  if (chain === null) {
    return null;
  }
  const lower = chain.toLowerCase();
  if (lower === "base" || lower === "8453") {
    return { label: "Base", isBase: true };
  }
  if (lower === "tempo") {
    return { label: "Tempo", isBase: false };
  }
  // Unknown chain string: hide the badge entirely rather than rendering an
  // empty oval. Marketplace surfaces only base/tempo officially today.
  return null;
}

// Marketplace workflows expose their public listing only — the underlying
// graph is intentionally hidden. Phase 44 ships the row as a purely
// informational record (rank / name / tags / calls / price / chain). Both
// the row-level navigation and the per-row "Use this workflow" CTA were
// removed at the user's request: the marketplace call/use-template flow
// is intentionally not exposed from the leaderboard. A future sub-phase
// can introduce a public listing surface (no graph) if needed.
export function MarketplaceRow({
  row,
  rank,
}: MarketplaceRowProps): React.ReactElement {
  const badge = chainBadge(row.chain);

  return (
    // biome-ignore lint/a11y/useSemanticElements: row is structurally a grid <div role="row"> per UI-SPEC §5; the surrounding <div role="table"> demands matching role children.
    // biome-ignore lint/a11y/useFocusableInteractive: marketplace row is purely informational since the row-click and CTA were removed; making it a tab stop would create empty stops with no associated action.
    <div
      aria-label={row.displayName}
      className="grid min-h-[3rem] grid-cols-[48px_1fr_220px_96px_96px_80px] items-center gap-x-3 border-border/20 border-b bg-[var(--color-hub-card)] px-4 py-3 last:border-b-0 even:bg-[var(--color-hub-overlay)]"
      role="row"
    >
      <span className="font-semibold text-muted-foreground text-sm tabular-nums">
        #{rank}
      </span>

      <span className="truncate font-semibold text-foreground text-sm">
        {row.displayName}
      </span>

      <div className="hidden flex-wrap gap-1 lg:flex">
        {row.tags.slice(0, 3).map((tag) => (
          <span
            className="rounded-full bg-[var(--color-hub-icon-bg)] px-2 py-0.5 font-medium text-[0.625rem] text-muted-foreground"
            key={tag}
          >
            {tag}
          </span>
        ))}
      </div>

      <span className="text-right font-semibold text-foreground text-sm tabular-nums">
        {callCountLabel(row.callCount)}
      </span>

      <span className="text-right font-mono font-semibold text-foreground text-xs tabular-nums">
        {priceLabel(row.priceUsdcPerCall)}
      </span>

      {badge ? (
        <span
          className={
            badge.isBase
              ? "hidden items-center justify-center justify-self-end rounded-full bg-[var(--color-bg-accent)] px-2 py-0.5 font-semibold text-[0.625rem] text-[var(--color-text-accent)] md:inline-flex"
              : "hidden items-center justify-center justify-self-end rounded-full bg-[var(--color-hub-icon-bg)] px-2 py-0.5 font-semibold text-[0.625rem] text-muted-foreground md:inline-flex"
          }
        >
          {badge.label}
        </span>
      ) : (
        <span
          className="hidden text-right font-mono font-semibold text-muted-foreground/40 text-xs md:inline"
          title="Chain unknown"
        >
          —
        </span>
      )}
    </div>
  );
}
