/**
 * Stub — Wave 0 placeholder for the suggestion engine.
 * Full implementation lands in Wave 2 (52-02-PLAN).
 *
 * This file exists so TypeScript resolves the import in the RED test files.
 * All exported functions throw "not implemented" so tests remain RED.
 */
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";

/** Minimal input shape used by the stub; Wave 2 wires the full ScanResponse. */
interface ScanInput {
  positions: unknown[];
  stablecoins: unknown[];
}

/**
 * Map a scan result to ranked SuggestionDescriptor[].
 * Stub: throws so Wave 0 tests remain RED; replaced in Wave 2.
 */
export function buildSuggestions(_scan: ScanInput): SuggestionDescriptor[] {
  throw new Error(
    "buildSuggestions: not yet implemented — lands in 52-02-PLAN (Wave 2)"
  );
}
