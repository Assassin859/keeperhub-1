"use client";

import { AlertCircle, Clock, Wallet } from "lucide-react";
import { ResultsHeader } from "@/components/scan/results-header";
import { SuggestionCard } from "@/components/scan/suggestion-card";
import { SuggestionCardSkeleton } from "@/components/scan/suggestion-card-skeleton";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { ScanResponse } from "@/lib/scan/types";

type ScanState = "loading" | "populated" | "empty" | "rate-limited" | "error";

type ScanResultsProps = {
  scanState: ScanState;
  data: ScanResponse | null;
  retryAfter: number | null;
  errorMessage: string | null;
  onCardSelect: (suggestion: SuggestionDescriptor) => void;
};

export function ScanResults({
  scanState,
  data,
  retryAfter,
  errorMessage,
  onCardSelect,
}: ScanResultsProps): React.ReactElement {
  return (
    <section
      aria-busy={scanState === "loading"}
      aria-label="Scan results"
      aria-live="polite"
      className="mt-8"
    >
      {scanState === "loading" && (
        <div className="flex flex-col gap-3">
          <SuggestionCardSkeleton />
          <SuggestionCardSkeleton />
          <SuggestionCardSkeleton />
        </div>
      )}

      {scanState === "populated" && data && (
        <>
          <ResultsHeader
            scannedAt={data.scannedAt}
            stablecoins={data.stablecoins}
            unavailableChains={data.unavailableChains}
          />
          <div className="flex flex-col gap-3">
            {(data.suggestions ?? []).map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                onSelect={onCardSelect}
                suggestion={suggestion}
              />
            ))}
          </div>
        </>
      )}

      {scanState === "empty" && (
        <div
          className="flex flex-col items-center justify-center py-16 text-center"
          data-testid="scan-results-empty"
        >
          <Wallet
            aria-hidden="true"
            className="mb-3 size-8 text-muted-foreground/40"
          />
          <h3 className="mb-2 font-semibold text-foreground text-sm">
            No positions found
          </h3>
          <p className="text-muted-foreground text-sm">
            Try a different address or check back after interacting with a
            supported protocol.
          </p>
        </div>
      )}

      {scanState === "rate-limited" && (
        <div
          className="flex items-start gap-3 rounded-md border border-[var(--color-border-error)] bg-[var(--color-bg-error)] px-4 py-3"
          data-testid="scan-results-rate-limited"
          role="alert"
        >
          <Clock
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-text-error)]"
          />
          <p className="text-[var(--color-text-error)] text-sm">
            Too many scan requests — try again in {retryAfter} minute
            {retryAfter === 1 ? "" : "s"}.
          </p>
        </div>
      )}

      {scanState === "error" && (
        <div
          className="flex items-start gap-3 rounded-md border border-[var(--color-border-error)] bg-[var(--color-bg-error)] px-4 py-3"
          data-testid="scan-results-error"
          role="alert"
        >
          <AlertCircle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-text-error)]"
          />
          <p className="text-[var(--color-text-error)] text-sm">
            {errorMessage ??
              "Unable to scan this address. Check that it is a valid EVM address and try again."}
          </p>
        </div>
      )}
    </section>
  );
}
