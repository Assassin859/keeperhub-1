import type { SimulateResult } from "@/lib/execute/simulate";
import { HttpStatus } from "@/lib/http-status";

const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * Map a simulation result to its API response status.
 *
 * Deterministic validation/revert failures are client-actionable and return
 * 400. Infrastructure failures return 503 and must never be interpreted as a
 * successful preflight.
 */
export function simulationHttpStatus(result: SimulateResult): number {
  if (result.success) {
    return HttpStatus.OK;
  }

  if (result.failureKind === "unavailable") {
    return HTTP_SERVICE_UNAVAILABLE;
  }

  return HttpStatus.BAD_REQUEST;
}
