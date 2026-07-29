// Client-safe USDC amount helpers. All PAYG money is USDC 6-decimal raw units
// (integers) stored/summed as strings; these convert to/from a human decimal.

export const USDC_DECIMALS = 6;

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** "0.0075" -> 7500n. Returns 0n for a malformed input. */
export function usdcDecimalToRaw(decimal: string): bigint {
  const trimmed = decimal.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    return BigInt(0);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = `${frac}${"0".repeat(USDC_DECIMALS)}`.slice(
    0,
    USDC_DECIMALS
  );
  const scale = BigInt(10) ** BigInt(USDC_DECIMALS);
  return BigInt(whole) * scale + BigInt(fracPadded || "0");
}

/** 7500n -> "0.007500". */
export function usdcRawToDecimal(raw: bigint): string {
  const scale = BigInt(10) ** BigInt(USDC_DECIMALS);
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}
