/**
 * Agentic-wallet signing helpers.
 *
 * Two signers proxy Turnkey signRawPayload so the npm client never holds a
 * Turnkey API key:
 *
 *   signX402Challenge -- EIP-3009 TransferWithAuthorization on Base USDC
 *   (chainId 8453, verifyingContract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).
 *   Returns a 132-char 0x-prefixed 65-byte signature (v-parity +27 via
 *   @turnkey/ethers::serializeSignature) that x402 facilitators ecrecover
 *   back to the wallet address.
 *
 *   signMppProof -- EIP-712 "Proof" typed-data on Tempo (chainId 4217).
 *   Phase 33 scope is proof-mode only (CONTEXT Resolution #3); pull-mode
 *   raw-transaction signing is deferred to Phase 34.
 *
 * Both call Turnkey with PAYLOAD_ENCODING_EIP712 + HASH_FUNCTION_NO_OP --
 * Turnkey hashes the typed-data internally when encoding is EIP712, but the
 * hashFunction field is still required and MUST be NO_OP (RESEARCH Pitfall in
 * Anti-Patterns section).
 *
 * On ACTIVITY_STATUS_CONSENSUS_NEEDED both helpers throw PolicyBlockedError so
 * the /sign route can translate to HTTP 403 POLICY_BLOCKED. Any other non-
 * COMPLETED status or missing result throws TurnkeyUpstreamError for 502.
 *
 * T-33-02 (Information Disclosure): this module never logs secrets, challenge
 * bodies, or signatures. Callers (the /sign route) own logging with sub-org
 * id only.
 */
import { serializeSignature } from "@turnkey/ethers";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import { BASE_CHAIN_ID, USDC_BASE_ADDRESS } from "./constants";

export class PolicyBlockedError extends Error {
  override readonly name = "PolicyBlockedError";
}

export class TurnkeyUpstreamError extends Error {
  readonly name = "TurnkeyUpstreamError";
  constructor(message: string) {
    super(message);
  }
}

// Source: lib/x402/reconcile.ts:4 + @x402/evm domain constant. Base USDC
// domain is the canonical TransferWithAuthorization EIP-712 domain.
export const BASE_USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_BASE_ADDRESS,
} as const;

export const AUTHORIZATION_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Source: mppx proof-mode EIP-712 types (33-RESEARCH Pattern 4). chainId
// 4217 is the Tempo mainnet id.
export const PROOF_DOMAIN_TEMPO = {
  name: "MPP",
  version: "1",
  chainId: 4217,
} as const;

export const PROOF_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
  Proof: [{ name: "challengeId", type: "string" }],
} as const;

export type X402Challenge = {
  payTo: string;
  amount: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
};

export type MppProofChallenge = {
  chainId: number;
  challengeId: string;
};

type TurnkeySignature = { r: string; s: string; v: string };

type TurnkeyActivityResponse = {
  activity?: {
    status?: string;
    result?: {
      signRawPayloadResult?: TurnkeySignature;
    };
  };
};

async function signTypedData(
  subOrgId: string,
  walletAddress: string,
  typedData: unknown
): Promise<string> {
  const client = getTurnkeyClientForOrg(subOrgId).apiClient();
  // Turnkey SDK v5.3.0's `signRawPayload` expects parameters FLAT (not nested
  // under a `parameters` object as the raw v1 activity API required). The
  // original v1 envelope `{type, organizationId, timestampMs, parameters}`
  // was rejected with "field required: signWith / payload / encoding".
  const response = (await (
    client as unknown as {
      signRawPayload: (args: unknown) => Promise<TurnkeyActivityResponse>;
    }
  ).signRawPayload({
    signWith: walletAddress,
    payload: JSON.stringify(typedData),
    encoding: "PAYLOAD_ENCODING_EIP712",
    hashFunction: "HASH_FUNCTION_NO_OP",
  })) as TurnkeyActivityResponse;

  const activity = response?.activity;
  const status = activity?.status;
  if (status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
    throw new PolicyBlockedError(
      "Turnkey policy blocked the activity (CONSENSUS_NEEDED)"
    );
  }
  if (status !== "ACTIVITY_STATUS_COMPLETED") {
    throw new TurnkeyUpstreamError(
      `Turnkey returned status ${status ?? "unknown"}`
    );
  }

  const result = activity?.result?.signRawPayloadResult;
  if (!result) {
    throw new TurnkeyUpstreamError("Signature missing from Turnkey response");
  }

  // serializeSignature assembles `0x${r}${s}${hex(v+27)}` (65 bytes / 132 hex
  // chars). It handles the Turnkey `v: "00"|"01"` -> Ethereum `v: 27|28`
  // parity offset required by EIP-3009 / EIP-712 recipients.
  return serializeSignature(result);
}

export async function signX402Challenge(
  subOrgId: string,
  walletAddress: string,
  challenge: X402Challenge
): Promise<string> {
  const message = {
    from: walletAddress,
    to: challenge.payTo,
    value: String(challenge.amount),
    validAfter: String(challenge.validAfter),
    validBefore: String(challenge.validBefore),
    nonce: challenge.nonce,
  };
  const typedData = {
    domain: BASE_USDC_DOMAIN,
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  };
  return signTypedData(subOrgId, walletAddress, typedData);
}

export async function signMppProof(
  subOrgId: string,
  walletAddress: string,
  challenge: MppProofChallenge
): Promise<string> {
  // Override PROOF_DOMAIN_TEMPO.chainId if the caller supplies a different
  // chainId (e.g. Tempo testnet). Default path is 4217 from the challenge.
  const typedData = {
    domain: { ...PROOF_DOMAIN_TEMPO, chainId: challenge.chainId },
    types: PROOF_TYPES,
    primaryType: "Proof",
    message: { challengeId: challenge.challengeId },
  };
  return signTypedData(subOrgId, walletAddress, typedData);
}
