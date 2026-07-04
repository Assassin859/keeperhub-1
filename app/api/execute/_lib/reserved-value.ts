import "server-only";

import {
  parseNativeValueWei,
  type ReservedValue,
} from "@/lib/execute/native-value";

// parseNativeValueWei lives in lib/execute so both the direct-execution routes
// (here) and the workflow step wrappers can charge native value against the
// same cap. Imported above for local use (parseNodeNativeValueWei), and
// re-exported for the routes/tests that import it from this path.
export {
  parseNativeValueWei,
  type ReservedValue,
} from "@/lib/execute/native-value";

/**
 * Native value (wei) reserved for a generic node execution.
 *
 * A native transfer forwards `amount`; every contract-write-style action
 * forwards native value via `ethValue`. Charging `ethValue` on the field name
 * (not the step name) means a future value-forwarding action is charged
 * automatically rather than silently reserving 0 (a cap bypass). Token
 * transfers/approvals and off-chain steps have neither field and correctly
 * reserve "0". `value` is deliberately NOT read -- it names non-broadcasting
 * inputs on other steps (e.g. risk analysis), so charging it would be wrong.
 */
export function parseNodeNativeValueWei(
  stepFunction: string,
  config: Record<string, unknown>
): ReservedValue {
  if (stepFunction === "transferFundsStep") {
    return parseNativeValueWei(
      typeof config.amount === "string" ? config.amount : undefined
    );
  }
  return parseNativeValueWei(
    typeof config.ethValue === "string" ? config.ethValue : undefined
  );
}
