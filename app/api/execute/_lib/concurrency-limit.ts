import "server-only";

import { db } from "@/lib/db";
import {
  checkConcurrencyLimit as checkConcurrencyLimitCore,
  type ConcurrencyLimitResult,
} from "@/lib/workflow/concurrency";

export type { ConcurrencyLimitResult };

/**
 * Route-side concurrency check, bound to the app db. Shares its implementation
 * with the executor via lib/workflow/concurrency so both enforce the same cap.
 */
export function checkConcurrencyLimit(): Promise<ConcurrencyLimitResult> {
  return checkConcurrencyLimitCore(db);
}
