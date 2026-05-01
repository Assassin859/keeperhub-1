"use client";

import Link from "next/link";
import type { KeyboardEvent, MouseEvent } from "react";
import type { MarketplaceLeaderboardRow } from "@/lib/marketplace/leaderboard-query";

type MarketplaceRowProps = {
  row: MarketplaceLeaderboardRow;
  rank: number;
  onUseTemplate?: (slug: string) => void;
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

function chainLabel(chain: string | null): { label: string; isBase: boolean } {
  const lower = (chain ?? "").toLowerCase();
  if (lower === "base" || lower === "8453") {
    return { label: "Base", isBase: true };
  }
  if (lower === "tempo") {
    return { label: "Tempo", isBase: false };
  }
  return { label: chain ?? "—", isBase: false };
}

export function MarketplaceRow({
  row,
  rank,
  onUseTemplate,
}: MarketplaceRowProps): React.ReactElement {
  const slug = row.listedSlug ?? "";
  const href = slug ? `/hub/${slug}` : "/hub";
  const chain = chainLabel(row.chain);

  const handleCtaClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    if (onUseTemplate && slug) {
      onUseTemplate(slug);
    }
  };

  const handleRowKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      window.location.assign(href);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: row uses an <article role="row"> with the ::before overlay click pattern per UI-SPEC §5; nested CTA button forbids wrapping <a>.
    <article
      aria-label={`Open ${row.displayName}`}
      className="group relative grid min-h-[3rem] cursor-pointer grid-cols-[48px_1fr_220px_96px_96px_80px_140px] items-center border-border/20 border-b bg-[var(--color-hub-card)] px-4 py-3 transition-colors duration-100 ease before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:content-[''] last:border-b-0 even:bg-[var(--color-row-stripe)] hover:bg-[var(--color-hub-icon-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] motion-reduce:transition-none"
      onKeyDown={handleRowKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: row interactive via ::before overlay + onKeyDown per UI-SPEC §5.
      role="row"
      tabIndex={0}
    >
      <Link
        aria-hidden="true"
        className="absolute inset-0 z-[1]"
        href={href}
        tabIndex={-1}
      />

      <span className="pointer-events-none relative z-[2] font-semibold text-muted-foreground text-sm tabular-nums">
        #{rank}
      </span>

      <span className="pointer-events-none relative z-[2] truncate font-semibold text-foreground text-sm">
        {row.displayName}
      </span>

      <div className="pointer-events-none relative z-[2] hidden flex-wrap gap-1 lg:flex">
        {/* Top-3 public tags: Phase 44 ships without the tag join in the Drizzle query — Task 1 deferred it to keep the SELECT whitelist narrow. The cell still occupies the grid track so the column template stays stable; a follow-up plan can populate. */}
      </div>

      <span className="pointer-events-none relative z-[2] text-right font-semibold text-foreground text-sm tabular-nums">
        {callCountLabel(row.callCount)}
      </span>

      <span className="pointer-events-none relative z-[2] text-right font-mono font-semibold text-foreground text-xs tabular-nums">
        {priceLabel(row.priceUsdcPerCall)}
      </span>

      <span
        className={
          chain.isBase
            ? "pointer-events-none relative z-[2] hidden items-center justify-center rounded-full bg-[var(--color-bg-accent)] px-2 py-0.5 font-semibold text-[0.625rem] text-[var(--color-text-accent)] md:inline-flex"
            : "pointer-events-none relative z-[2] hidden items-center justify-center rounded-full bg-[var(--color-hub-icon-bg)] px-2 py-0.5 font-semibold text-[0.625rem] text-muted-foreground md:inline-flex"
        }
      >
        {chain.label}
      </span>

      <button
        aria-label={`Use ${row.displayName} as a template`}
        className="pointer-events-auto relative z-[2] h-8 rounded-md bg-[var(--ds-green-accent)] px-3 font-semibold text-[var(--color-bg-inverse)] text-xs transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-hub-card)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        onClick={handleCtaClick}
        type="button"
      >
        Use this workflow
      </button>
    </article>
  );
}
