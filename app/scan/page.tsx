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
  const [selectedVariants, setSelectedVariants] = useState<
    SuggestionDescriptor[]
  >([]);
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
        // The API returns retryAfter in SECONDS; the banner renders minutes.
        // Convert to whole minutes (min 1) and fall back to 60 (hourly limit)
        // when the field is absent or non-positive.
        const retrySeconds = body.retryAfter;
        setRetryAfter(
          retrySeconds && retrySeconds > 0
            ? Math.max(1, Math.ceil(retrySeconds / 60))
            : 60
        );
        setScanState("rate-limited");
        return;
      }

      if (!res.ok) {
        setErrorMessage(
          "The scan service is temporarily unavailable. Please try again."
        );
        setScanState("error");
        return;
      }

      const data = (await res.json()) as ScanResponse;
      setScanData(data);
      setScanState(data.suggestions?.length ? "populated" : "empty");
    } catch {
      setErrorMessage(
        "Couldn't reach the scanner. Check your connection and try again."
      );
      setScanState("error");
    }
  };

  const handleScanSubmit = (): void => {
    handleScan().catch(() => {
      // Errors are handled inside handleScan's try/catch block.
    });
  };

  const handleCardSelect = (
    suggestion: SuggestionDescriptor,
    variants: SuggestionDescriptor[]
  ): void => {
    // Capture the currently focused element so focus can return on drawer close.
    triggerRef.current = document.activeElement as HTMLElement | null;
    setSelectedSuggestion(suggestion);
    setSelectedVariants(variants);
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

  // HARDEN-04: hooks are all declared above; this branch lives in the render
  // path (not before hooks) so biome useHookAtTopLevel is not triggered.
  // NEXT_PUBLIC_* vars are build-time inlined — the value is constant per build.
  if (process.env.NEXT_PUBLIC_SCAN_ENABLED !== "true") {
    return (
      <main className="pointer-events-auto flex min-h-screen items-center justify-center bg-[var(--color-hub-overlay)] pt-[var(--header-height)]">
        <p className="text-muted-foreground text-sm">
          Wallet scanning is not available yet.
        </p>
      </main>
    );
  }

  return (
    <>
      <main className="pointer-events-auto fixed inset-0 overflow-y-auto bg-[var(--color-hub-overlay)] pt-[calc(5rem+var(--app-banner-height,0px))]">
        <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
          <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
            {isCompact ? (
              <div className="mx-auto max-w-2xl py-4">
                <ScanInput
                  disabled={isLoading}
                  error={inputError}
                  onChange={handleAddressChange}
                  onSubmit={handleScanSubmit}
                  value={address}
                />
              </div>
            ) : (
              <div className="mx-auto max-w-2xl py-12 text-center sm:py-16">
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
        </div>
      </main>

      <SuggestionPreviewDrawer
        address={address}
        isAuthenticated={isAuthenticated}
        onOpenChange={handlePreviewOpenChange}
        open={previewOpen}
        suggestion={selectedSuggestion}
        variants={selectedVariants}
      />
    </>
  );
}
