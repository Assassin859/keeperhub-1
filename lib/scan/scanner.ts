import "server-only";

import type { ScanResponse } from "@/lib/scan/types";

// RED phase stub — replaced by full implementation in the GREEN commit.
export function scanAddress(_rawAddress: string): Promise<ScanResponse> {
  return Promise.reject(new Error("scanAddress: not yet implemented"));
}
