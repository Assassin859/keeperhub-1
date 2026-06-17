/**
 * Stub — Wave 0 placeholder for the deterministic workflow factory.
 * Full implementation lands in Wave 2 (52-03-PLAN).
 *
 * This file exists so TypeScript resolves the import in the RED test files.
 * All exported functions throw "not implemented" so tests remain RED.
 */

import type { PrefillWorkflow } from "@/lib/scan/factory/types";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";

/**
 * Map a SuggestionDescriptor to a deterministic PrefillWorkflow.
 * Stub: throws so Wave 0 tests remain RED; replaced in Wave 2.
 */
export function buildWorkflow(
  _descriptor: SuggestionDescriptor
): PrefillWorkflow {
  throw new Error(
    "buildWorkflow: not yet implemented — lands in 52-03-PLAN (Wave 2)"
  );
}
