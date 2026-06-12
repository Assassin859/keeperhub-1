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
import { SUPPORTED_CHAIN_IDS } from "@/lib/rpc/types";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";

// Cap the typed-data payload. Turnkey rejects oversized payloads anyway;
// catching it here returns a clean ValidationError instead of an opaque
// upstream 502. 32 KiB is comfortably larger than any real EIP-712 payload
// (the largest production case — Permit2 batched permits — is ~3 KiB).
const MAX_TYPED_DATA_BYTES = 32 * 1024;

/**
 * A-06 hardening. This step signs caller/config-supplied EIP-712 typed-data
 * with the organization's default (creator EOA) Turnkey-backed wallet
 * unconditionally. A malicious marketplace template can embed a hardcoded
 * fund-moving authorization (an ERC-2612 / DAI / Permit2 `Permit`, an
 * EIP-3009 `TransferWithAuthorization`, a governance `DelegateBySig`, etc.)
 * so that a victim who deploys + runs the template signs an off-chain
 * approval that drains their tokens. We refuse to sign those primaryTypes
 * here, at the web3 STEP boundary.
 *
 * This guard is deliberately NOT placed in `signTypedDataWithTurnkey`
 * (lib/agentic-wallet/sign-typed-data.ts). That primitive is shared with the
 * x402 / MPP / agentic-wallet signers, which legitimately sign arbitrary
 * buyer-side payloads (including `TransferWithAuthorization`) from a SEPARATE
 * protected sub-org + entrypoint (lib/agentic-wallet/sign.ts ->
 * /api/agentic-wallet/sign) and are therefore unaffected by this denylist.
 *
 * Matched case-insensitively. The non-`permit` names below are not caught by
 * the substring backstop, so they must be listed explicitly.
 */
const FUND_MOVING_PRIMARY_TYPES: ReadonlySet<string> = new Set(
  [
    "Permit",
    "PermitSingle",
    "PermitBatch",
    "PermitTransferFrom",
    "PermitBatchTransferFrom",
    "PermitWitnessTransferFrom",
    "PermitBatchWitnessTransferFrom",
    "ERC20Permit",
    "DAIPermit",
    "TransferWithAuthorization",
    "ReceiveWithAuthorization",
    "CancelAuthorization",
    "DelegateBySig",
    "Delegation",
  ].map((name) => name.toLowerCase())
);

// Backstop: any primaryType whose lowercased form CONTAINS "permit"
// (e.g. a custom "MyPermitThing") is a fund-moving authorization we refuse
// to sign even if it is not in the explicit denylist above.
const PERMIT_SUBSTRING = "permit";

// EIP-712 `domain.chainId`, when present, must name a chain KeeperHub
// actually supports. An unknown chainId signals a payload aimed at a
// contract/network we never vetted. Derived from the same canonical
// `SUPPORTED_CHAIN_IDS` map that `lib/rpc/network-utils` resolves against.
const SUPPORTED_CHAIN_ID_SET: ReadonlySet<number> = new Set<number>(
  Object.values(SUPPORTED_CHAIN_IDS)
);

const HEX_CHAIN_ID_RE = /^0x[0-9a-f]+$/i;

// `domain.chainId` may arrive as a number, a decimal string, a 0x-hex
// string, or a bigint. Normalize to a positive integer, or null if it is
// not a parseable positive chain id.
function normalizeChainId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "bigint") {
    return value > BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const radix = HEX_CHAIN_ID_RE.test(trimmed) ? 16 : 10;
    const parsed = Number.parseInt(trimmed, radix);
    return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
  }
  return null;
}

type SignTypedDataValidationFailure = {
  success: false;
  code: "VALIDATION";
  error: string;
};

// A-06 control surface: reject fund-moving primaryTypes and unsupported
// (present-but-unknown) domain.chainIds. Returns a VALIDATION failure to
// short-circuit signing, or null when the payload is safe to sign. Absent
// chainId is allowed: many legitimate EIP-712 domains omit it, so the
// primaryType denylist remains the primary control.
function checkSignableTypedData(
  typedData: EIP712TypedData
): SignTypedDataValidationFailure | null {
  const primaryTypeLower = typedData.primaryType.toLowerCase();
  if (
    FUND_MOVING_PRIMARY_TYPES.has(primaryTypeLower) ||
    primaryTypeLower.includes(PERMIT_SUBSTRING)
  ) {
    return {
      success: false,
      code: "VALIDATION",
      error: `Refusing to sign fund-moving authorization "${typedData.primaryType}". EIP-712 permit / transfer-authorization / delegation signing is blocked on this step to prevent template-injected token drains.`,
    };
  }

  const domainChainId = typedData.domain.chainId;
  if (domainChainId === undefined || domainChainId === null) {
    return null;
  }
  const normalizedChainId = normalizeChainId(domainChainId);
  if (
    normalizedChainId === null ||
    !SUPPORTED_CHAIN_ID_SET.has(normalizedChainId)
  ) {
    return {
      success: false,
      code: "VALIDATION",
      error: `typedData.domain.chainId ${JSON.stringify(domainChainId)} is not a supported chain`,
    };
  }
  return null;
}

export type SignTypedDataCoreInput = {
  /**
   * The EIP-712 typed-data payload. Standard shape:
   *   { domain, types, primaryType, message }
   * Accepted as either a native object (direct/MCP callers) or a JSON
   * string (the workflow UI's `json-editor` field emits this shape via
   * Monaco). Strings are parsed before validation; native objects are
   * forwarded verbatim to Turnkey (which hashes and signs server-side
   * under PAYLOAD_ENCODING_EIP712).
   */
  typedData: EIP712TypedData | string;
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
  // The `json-editor` UI field (Monaco-backed) emits its value as a JSON
  // string, while direct/MCP callers pass a native object. Parse the string
  // shape here so the validator and downstream Turnkey call always receive
  // a native object. Mirrors the JSON.parse / try-catch pattern used by
  // `resolveArraySource` in lib/workflow/executor/executor.workflow.ts.
  let typedData: unknown = input.typedData;
  if (typeof typedData === "string") {
    try {
      typedData = JSON.parse(typedData);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        code: "VALIDATION",
        error: `typedData is not valid JSON: ${detail}`,
      };
    }
  }

  if (!validateTypedData(typedData)) {
    return {
      success: false,
      code: "VALIDATION",
      error:
        "typedData must be an object with domain, types, primaryType, and message fields",
    };
  }

  const serialized = JSON.stringify(typedData);
  if (serialized.length > MAX_TYPED_DATA_BYTES) {
    return {
      success: false,
      code: "VALIDATION",
      error: `typedData payload exceeds ${MAX_TYPED_DATA_BYTES}-byte limit (got ${serialized.length})`,
    };
  }

  // A-06: block template-injected Permit/transfer-authorization drains and
  // unsupported chainIds BEFORE any wallet/org resolution, so a denied
  // payload never reaches the Turnkey signer. See FUND_MOVING_PRIMARY_TYPES.
  const signabilityFailure = checkSignableTypedData(typedData);
  if (signabilityFailure) {
    return signabilityFailure;
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
      typedData
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
