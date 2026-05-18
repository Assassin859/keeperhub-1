/**
 * Core EIP-712 typed-data signing logic shared between the web3
 * sign-typed-data step and any future direct-execution / MCP wrappers.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * KEEP-473: workflows previously had no way to produce signed EIP-712
 * typed-data destined for HTTP bodies (x402 EIP-3009
 * transferWithAuthorization, MPP, EIP-2612 permits, custom protocol
 * intents). Buyers had to deploy AWS Lambda + KMS to sign outside KH.
 * This primitive routes the request through the org's Turnkey-backed
 * wallet so the signature is produced inside KH's trust boundary.
 */
import "server-only";

import {
  type EIP712TypedData,
  PolicyBlockedError,
  signTypedDataWithTurnkey,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign-typed-data";
import { toChecksumAddress } from "@/lib/address-utils";
import { getOrganizationWallet } from "@/lib/para/wallet-helpers";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";

// Cap the typed-data payload. Turnkey rejects oversized payloads anyway;
// catching it here returns a clean ValidationError instead of an opaque
// upstream 502. 32 KiB is comfortably larger than any real EIP-712 payload
// (the largest production case — Permit2 batched permits — is ~3 KiB).
const MAX_TYPED_DATA_BYTES = 32 * 1024;

export type SignTypedDataCoreInput = {
  /**
   * The EIP-712 typed-data object. Standard shape:
   *   { domain, types, primaryType, message }
   * The step does NOT modify it; it is forwarded verbatim to Turnkey
   * (which hashes and signs server-side under PAYLOAD_ENCODING_EIP712).
   */
  typedData: EIP712TypedData;
  _context?: {
    executionId?: string;
    organizationId?: string;
    userId?: string;
  };
};

export type SignTypedDataResult =
  | {
      success: true;
      signature: string;
      signer: string;
    }
  | {
      success: false;
      error: string;
      code:
        | "VALIDATION"
        | "NO_WALLET"
        | "POLICY_BLOCKED"
        | "UPSTREAM"
        | "UNKNOWN";
    };

function validateTypedData(typedData: unknown): typedData is EIP712TypedData {
  if (!typedData || typeof typedData !== "object") {
    return false;
  }
  const td = typedData as Record<string, unknown>;
  if (!td.domain || typeof td.domain !== "object") {
    return false;
  }
  if (!td.types || typeof td.types !== "object") {
    return false;
  }
  if (typeof td.primaryType !== "string" || td.primaryType.length === 0) {
    return false;
  }
  if (!td.message || typeof td.message !== "object") {
    return false;
  }
  return true;
}

export async function signTypedDataCore(
  input: SignTypedDataCoreInput
): Promise<SignTypedDataResult> {
  if (!validateTypedData(input.typedData)) {
    return {
      success: false,
      code: "VALIDATION",
      error:
        "typedData must be an object with domain, types, primaryType, and message fields",
    };
  }

  const serialized = JSON.stringify(input.typedData);
  if (serialized.length > MAX_TYPED_DATA_BYTES) {
    return {
      success: false,
      code: "VALIDATION",
      error: `typedData payload exceeds ${MAX_TYPED_DATA_BYTES}-byte limit (got ${serialized.length})`,
    };
  }

  const ctx = await resolveOrganizationContext(
    {
      executionId: input._context?.executionId,
      organizationId: input._context?.organizationId,
    },
    "[sign-typed-data]",
    "sign-typed-data"
  );
  if (!ctx.success) {
    return {
      success: false,
      code: "NO_WALLET",
      error: ctx.error,
    };
  }
  const { organizationId } = ctx;

  let wallet: { walletAddress: string; turnkeySubOrgId: string | null };
  try {
    wallet = await getOrganizationWallet(organizationId);
  } catch (err) {
    return {
      success: false,
      code: "NO_WALLET",
      error: err instanceof Error ? err.message : "Failed to load organization wallet",
    };
  }

  if (!wallet.turnkeySubOrgId) {
    return {
      success: false,
      code: "NO_WALLET",
      error:
        "Organization wallet is not Turnkey-backed; EIP-712 signing requires a Turnkey wallet",
    };
  }

  const checksummed = toChecksumAddress(wallet.walletAddress);

  try {
    const signature = await signTypedDataWithTurnkey(
      wallet.turnkeySubOrgId,
      checksummed,
      input.typedData
    );
    return {
      success: true,
      signature,
      signer: checksummed,
    };
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      return {
        success: false,
        code: "POLICY_BLOCKED",
        error: err.message,
      };
    }
    if (err instanceof TurnkeyUpstreamError) {
      return {
        success: false,
        code: "UPSTREAM",
        error: err.message,
      };
    }
    return {
      success: false,
      code: "UNKNOWN",
      error: err instanceof Error ? err.message : "Signing failed",
    };
  }
}
