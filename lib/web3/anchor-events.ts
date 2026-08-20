import "server-only";

import { BorshEventCoder, type Idl } from "@coral-xyz/anchor";

// Anchor programs emit events as base64 blobs on a `Program data: <base64>`
// log line (CPI events use `Program log:` with the same payload). Decoding
// them against the program's Anchor IDL is the Solana analog of decoding an
// EVM event's args from its ABI.
const ANCHOR_EVENT_LOG_PREFIX = "Program data: ";

export type DecodedAnchorEvent = {
  name: string;
  data: Record<string, unknown>;
};

export class AnchorEventDecoder {
  private readonly coder: BorshEventCoder;

  constructor(idl: Idl) {
    this.coder = new BorshEventCoder(idl);
  }

  /**
   * Decode every Anchor event emitted in a transaction's log messages.
   * Non-event log lines and blobs that do not match this IDL are skipped.
   */
  decodeLogs(logs: string[]): DecodedAnchorEvent[] {
    const events: DecodedAnchorEvent[] = [];
    for (const line of logs) {
      if (!line.startsWith(ANCHOR_EVENT_LOG_PREFIX)) {
        continue;
      }
      const base64 = line.slice(ANCHOR_EVENT_LOG_PREFIX.length).trim();
      try {
        const decoded = this.coder.decode(base64);
        if (decoded) {
          events.push({
            name: decoded.name,
            data: decoded.data as Record<string, unknown>,
          });
        }
      } catch {
        // A blob that does not belong to this IDL is expected noise (other
        // programs' data lines); skip it rather than fail the whole tx.
      }
    }
    return events;
  }
}

/**
 * Parse an IDL JSON string and build a decoder. Returns null (raw mode) when
 * the string is absent, malformed, or not a usable Anchor IDL - callers
 * degrade to emitting raw logs rather than failing, matching the live Solana
 * event trigger's behavior.
 */
export function createEventDecoder(
  idlJson: string | undefined
): AnchorEventDecoder | null {
  if (!idlJson || idlJson.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(idlJson);
  } catch {
    return null;
  }
  try {
    return new AnchorEventDecoder(parsed as Idl);
  } catch {
    return null;
  }
}
