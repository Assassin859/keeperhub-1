import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MessageAttributeValue } from "@aws-sdk/client-sqs";

/**
 * HMAC signing and verification for SQS workflow-trigger messages.
 *
 * The executor consumes fund-moving trigger messages off SQS. The HTTP path to
 * the same executor is HMAC-protected (lib/internal-service-auth.ts); this
 * brings the SQS path to parity so a principal that can only sqs:SendMessage
 * cannot forge a trigger for an arbitrary workflow.
 *
 * Scheme mirrors the HTTP signer (lib/internal-service-auth.ts computeSignature)
 * minus the HTTP method/path, with a fixed "sqs" domain-separation prefix so an
 * HTTP signature can never be replayed as an SQS one and vice versa:
 *
 *   signingString = "sqs\n<caller>\n<sha256hex(body)>\n<unixSeconds>"
 *   signature     = hex(hmac_sha256(secret, signingString))
 *
 * The proof travels as SQS MessageAttributes (X-KH-Caller / X-KH-Timestamp /
 * X-KH-Signature), leaving the message body byte-for-byte unchanged.
 *
 * NOTE: the scheduler and event-tracker are isolated packages that cannot import
 * root lib/, so the SIGN half of this module is copied verbatim into
 * keeperhub-scheduler/lib/sqs-message-auth.ts and
 * keeperhub-events/event-tracker/lib/sqs-message-auth.ts (same pattern as the
 * per-service signHmacHeaders / log-facade copies). Keep the signing string,
 * attribute names, and caller set in sync across all three files - the shared
 * anti-drift test vector guards this.
 */

export const SQS_HMAC_CALLERS = ["scheduler", "events", "app"] as const;
export type SqsHmacCaller = (typeof SQS_HMAC_CALLERS)[number];

export const SQS_SIGNATURE_ATTR = "X-KH-Signature";
export const SQS_TIMESTAMP_ATTR = "X-KH-Timestamp";
export const SQS_CALLER_ATTR = "X-KH-Caller";

const SIGNATURE_HEX_LENGTH = 64; // sha256 hex

function computeSqsSignature(
  secret: string,
  caller: string,
  body: string,
  timestamp: string
): string {
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `sqs\n${caller}\n${bodyDigest}\n${timestamp}`;
  return createHmac("sha256", secret).update(signingString).digest("hex");
}

/**
 * Build the signed SQS MessageAttributes for `body`. Merge the result into the
 * producer's existing attributes (TriggerType / WorkflowId). Sign the exact
 * string passed as MessageBody.
 */
export function signSqsMessageAttributes(
  caller: SqsHmacCaller,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Record<string, MessageAttributeValue> {
  const secret = process.env.INTERNAL_SERVICE_HMAC_SECRET ?? "";
  const timestamp = String(nowSeconds);
  const signature = computeSqsSignature(secret, caller, body, timestamp);
  return {
    [SQS_CALLER_ATTR]: { DataType: "String", StringValue: caller },
    [SQS_TIMESTAMP_ATTR]: { DataType: "String", StringValue: timestamp },
    [SQS_SIGNATURE_ATTR]: { DataType: "String", StringValue: signature },
  };
}

export type SqsVerifyResult =
  | { ok: true; caller: SqsHmacCaller; ageSeconds: number }
  | { ok: false; reason: "unsigned" | "unknown_caller" | "bad_signature" };

/**
 * Current signing secret plus an optional previous secret, so a secret rotation
 * can flip producers and the executor independently without dropping in-flight
 * messages during the changeover. Empty secrets are ignored.
 */
function activeSecrets(): string[] {
  return [
    process.env.INTERNAL_SERVICE_HMAC_SECRET,
    process.env.INTERNAL_SERVICE_HMAC_SECRET_PREVIOUS,
  ].filter((secret): secret is string => Boolean(secret));
}

/**
 * Verify an SQS message's signature against `body` (the raw MessageBody string).
 * Freshness is NOT enforced here - the age since signing is returned so the
 * caller can treat it as advisory (a legitimately-signed message can sit in the
 * queue for a long time during a backlog, so dropping on age would lose real
 * triggers during an executor outage).
 */
export function verifySqsMessageSignature(
  body: string,
  attributes: Record<string, MessageAttributeValue> | undefined
): SqsVerifyResult {
  const caller = attributes?.[SQS_CALLER_ATTR]?.StringValue;
  const timestamp = attributes?.[SQS_TIMESTAMP_ATTR]?.StringValue;
  const signature = attributes?.[SQS_SIGNATURE_ATTR]?.StringValue;

  if (!(caller && timestamp && signature)) {
    return { ok: false, reason: "unsigned" };
  }
  if (!SQS_HMAC_CALLERS.includes(caller as SqsHmacCaller)) {
    return { ok: false, reason: "unknown_caller" };
  }
  // A sha256-hex signature is always 64 chars; anything else is malformed and
  // would throw in Buffer length handling below. Length is not secret.
  if (signature.length !== SIGNATURE_HEX_LENGTH) {
    return { ok: false, reason: "bad_signature" };
  }

  const providedBuf = Buffer.from(signature, "hex");
  for (const secret of activeSecrets()) {
    const expected = computeSqsSignature(secret, caller, body, timestamp);
    const expectedBuf = Buffer.from(expected, "hex");
    if (
      providedBuf.length === expectedBuf.length &&
      timingSafeEqual(providedBuf, expectedBuf)
    ) {
      const ts = Number.parseInt(timestamp, 10);
      const ageSeconds = Number.isFinite(ts)
        ? Math.floor(Date.now() / 1000) - ts
        : 0;
      return { ok: true, caller: caller as SqsHmacCaller, ageSeconds };
    }
  }
  return { ok: false, reason: "bad_signature" };
}
