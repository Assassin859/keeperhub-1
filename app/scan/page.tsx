"use client";

import { useRef, useState } from "react";
import { ScanDisclaimer } from "@/components/scan/scan-disclaimer";
import { ScanInput } from "@/components/scan/scan-input";
import { ScanResults } from "@/components/scan/scan-results";
import { SuggestionPreviewDrawer } from "@/components/scan/suggestion-preview-drawer";
import { useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { ScanResponse } from "@/lib/scan/types";

type ScanState =
  | "idle"
  | "loading"
  | "populated"
  | "empty"
  | "rate-limited"
  | "error";

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export default function ScanPage(): React.ReactElement {
  const [address, setAddress] = useState<string>("");
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | undefined>(undefined);
  const [selectedSuggestion, setSelectedSuggestion] =
    useState<SuggestionDescriptor | null>(null);
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  const { data: session } = useSession();
  const isAuthenticated =
    Boolean(session?.user) && !isAnonymousUser(session?.user);

  const handleAddressChange = (value: string): void => {
    setAddress(value);
    if (inputError) {
      setInputError(undefined);
    }
  };

  const handleScan = async (): Promise<void> => {
    if (!ADDRESS_REGEX.test(address)) {
      setInputError("Enter a valid EVM address (0x...)");
      return;
    }

    setInputError(undefined);
    setScanState("loading");

    try {
      const res = await fetch(`/api/scan/${encodeURIComponent(address)}`);

      if (res.status === 429) {
        const body = (await res.json()) as { retryAfter?: number };
        setRetryAfter(body.retryAfter ?? null);
        setScanState("rate-limited");
        return;
      }

      if (!res.ok) {
        setErrorMessage(null);
        setScanState("error");
        return;
      }

      const data = (await res.json()) as ScanResponse;
      setScanData(data);
      setScanState(data.suggestions?.length ? "populated" : "empty");
    } catch {
      setScanState("error");
    }
  };

  const handleScanSubmit = (): void => {
    handleScan().catch(() => {
      // Errors are handled inside handleScan's try/catch block.
    });
  };

  const handleCardSelect = (suggestion: SuggestionDescriptor): void => {
    // Capture the currently focused element so focus can return on drawer close.
    triggerRef.current = document.activeElement as HTMLElement | null;
    setSelectedSuggestion(suggestion);
    setPreviewOpen(true);
  };

  const handlePreviewOpenChange = (open: boolean): void => {
    setPreviewOpen(open);
    if (!open) {
      triggerRef.current?.focus();
    }
  };

  const isCompact = scanState !== "idle";
  const isLoading = scanState === "loading";

  return (
    <>
      <main className="pointer-events-auto min-h-screen bg-[var(--color-hub-overlay)] pt-[var(--header-height)]">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          {isCompact ? (
            <div className="py-4">
              <ScanInput
                disabled={isLoading}
                error={inputError}
                onChange={handleAddressChange}
                onSubmit={handleScanSubmit}
                value={address}
              />
            </div>
          ) : (
            <div className="py-12 text-center sm:py-16">
              <h1 className="mb-3 text-3xl font-bold leading-tight tracking-tight text-foreground">
                Scan your wallet
              </h1>
              <p className="mb-8 text-muted-foreground text-sm">
                Paste an EVM address to see DeFi positions and suggested
                automations.
              </p>
              <ScanInput
                disabled={isLoading}
                error={inputError}
                onChange={handleAddressChange}
                onSubmit={handleScanSubmit}
                value={address}
              />
            </div>
          )}

          {scanState !== "idle" && (
            <ScanResults
              data={scanData}
              errorMessage={errorMessage}
              onCardSelect={handleCardSelect}
              retryAfter={retryAfter}
              scanState={scanState}
            />
          )}

          {scanState === "populated" && <ScanDisclaimer />}
        </div>
      </main>

      <SuggestionPreviewDrawer
        isAuthenticated={isAuthenticated}
        onOpenChange={handlePreviewOpenChange}
        open={previewOpen}
        suggestion={selectedSuggestion}
      />
    </>
  );
}
