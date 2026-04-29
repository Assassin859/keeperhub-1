/**
 * Turnkey policy DSL definitions + facilitator allowlist.
 *
 * GUARD-06 baseline policies applied ONCE at sub-org creation time.
 * Plan 33-02 (/sign) must NOT call createPolicy or updatePolicy.
 *
 * Phase 37: the eth.tx.* policies fire on signTransaction activities (not
 * exercised by /sign today, kept for future-proofing). The eth.eip_712.*
 * policies fire on signRawPayload + PAYLOAD_ENCODING_EIP712 (the current
 * /sign codepath). Server-side payTo + chainId checks in /sign route are
 * defence-in-depth on top of these.
 */
import type { Turnkey } from "@turnkey/sdk-server";

// USDC contract addresses — CONTEXT Resolution #2 (locked 2026-04-21).
// Single source of truth lives in ./constants.
import {
  USDC_BASE_ADDRESS,
  USDC_BASE_LC,
  USDC_TEMPO_ADDRESS,
  USDC_TEMPO_LC,
} from "./constants";

export const FACILITATOR_ALLOWLIST: readonly string[] = [
  USDC_BASE_ADDRESS,
  USDC_TEMPO_ADDRESS,
] as const;

export type BaselinePolicy = {
  readonly policyName: string;
  readonly effect: "EFFECT_DENY";
  readonly condition: string;
  readonly notes: string;
};

// Baseline Turnkey policies (GUARD-06) — applied once at sub-org creation.
// /sign MUST NOT update or remove these (T-33-03 mitigation).
//
// Phase 37: split into two namespace groups. The eth.tx.* group catches any
// future signTransaction codepath. The eth.eip_712.* group is the actual
// gate on signRawPayload + PAYLOAD_ENCODING_EIP712 (the current /sign path).
// Both groups land at provision time; either firing means deny.
export const BASELINE_POLICIES: readonly BaselinePolicy[] = [
  {
    policyName: "block-erc20-unlimited-approve",
    effect: "EFFECT_DENY",
    // Phase 37 fix #8: threshold was >= 2^32 (= 4294 USDC), comment said
    // "unlimited". Now matches the per-transfer cap: any approve over $100.
    condition:
      "eth.tx.function_signature == '0x095ea7b3' && eth.tx.contract_call_args['value'] > 100000000",
    notes: "GUARD-06: block ERC-20 approvals above 100 USDC",
  },
  {
    policyName: "block-erc20-transfer-over-100usdc",
    effect: "EFFECT_DENY",
    condition:
      "(eth.tx.function_signature == '0xa9059cbb' && eth.tx.contract_call_args['value'] > 100000000) || (eth.tx.function_signature == '0x23b872dd' && eth.tx.contract_call_args['value'] > 100000000)",
    notes: "GUARD-06: block ERC-20 transfers above 100 USDC",
  },
  {
    policyName: "allowlist-outbound-contracts",
    effect: "EFFECT_DENY",
    condition: `!(eth.tx.to in ['${USDC_BASE_LC}', '${USDC_TEMPO_LC}'])`,
    notes: "GUARD-06: only permit outbound calls to allowlisted USDC contracts",
  },
  // Phase 37 fix #1 (revised): eth.tx.* fields are NOT populated for
  // signRawPayload with PAYLOAD_ENCODING_EIP712. The three policies below are
  // the actual gate on the current /sign codepath.
  //
  // LIVE API CORRECTIONS (validated against Turnkey staging 2026-04-22):
  //   - activity.parameters.encoding does not exist in the DSL; dropped.
  //     eth.eip_712.* fields are only populated for EIP-712 payloads, so the
  //     activity.type check alone is the implicit discriminator.
  //   - domain.verifyingContract -> domain.verifying_contract (snake_case)
  //   - domain.chainId -> domain.chain_id (snake_case); integer `in [...]`
  //     is not supported for numeric fields — expanded to `== x || == y` form.
  //   - message.value -> message['value'] (bracket notation; EIP-712 message
  //     fields are a dynamic map, dot access fails for arbitrary key names).
  //   - chain_id policy updated to match ALLOWED_TEMPO_CHAIN_IDS: adds 4218
  //     (Tempo testnet) alongside 8453 (Base mainnet) and 4217 (Tempo mainnet).
  {
    policyName: "block-eip712-foreign-domain",
    effect: "EFFECT_DENY",
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && !(eth.eip_712.domain.verifying_contract in ['${USDC_BASE_LC}', '${USDC_TEMPO_LC}'])`,
    notes:
      "GUARD-06 (EIP-712): only permit typed-data signing for allowlisted USDC domains",
  },
  {
    policyName: "block-eip712-erc3009-overcap",
    effect: "EFFECT_DENY",
    condition:
      "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && eth.eip_712.primary_type == 'TransferWithAuthorization' && eth.eip_712.message['value'] > 100000000",
    notes:
      "GUARD-06 (EIP-712): block EIP-3009 TransferWithAuthorization above 100 USDC",
  },
  {
    policyName: "block-eip712-foreign-chainid",
    effect: "EFFECT_DENY",
    condition:
      "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && !(eth.eip_712.domain.chain_id == 8453 || eth.eip_712.domain.chain_id == 4217 || eth.eip_712.domain.chain_id == 4218)",
    notes:
      "GUARD-06 (EIP-712): only permit Base mainnet (8453), Tempo mainnet (4217), or Tempo testnet (4218) chain ids",
  },
] as const;

type ApiClient = ReturnType<Turnkey["apiClient"]>;

/**
 * Thrown when baseline policies could not be applied completely to a
 * freshly-created sub-org. The provisioning flow catches this and treats
 * the sub-org as unusable (the caller must NOT return an hmacSecret since
 * GUARD-06 says Turnkey policy is the ONLY hard limit -- a sub-org with
 * partial policy coverage is dangerous).
 *
 * REVIEW HI-04: prefer this typed error over generic Error so the
 * provisioning path can react deterministically without substring-matching
 * on .message. The instance still inherits from Error for log fidelity.
 */
export class PolicyIncompleteError extends Error {
  override readonly name = "PolicyIncompleteError";
  readonly failures: readonly string[];
  readonly subOrgId: string;
  constructor(subOrgId: string, failures: readonly string[]) {
    super(
      `Baseline policies incomplete for sub-org ${subOrgId}: ${failures.join(", ")}`
    );
    this.subOrgId = subOrgId;
    this.failures = failures;
  }
}

/**
 * Apply all three baseline DENY policies to a freshly-created sub-org.
 *
 * REVIEW HI-04 (Partial policy coverage): previously the helper used
 * Promise.all, so a single createPolicy rejection rejected the whole
 * batch but the already-issued createPolicy calls remained on Turnkey's
 * side. That left the sub-org with 1 or 2 of the 3 baseline DENY rules,
 * violating GUARD-06 ("Turnkey policy is the ONLY hard limit"). The new
 * flow uses Promise.allSettled to observe every outcome, then on ANY
 * failure:
 *
 *   1. Best-effort deletes policies that DID succeed so the sub-org is
 *      left fully unprotected (no partial coverage that looks safe but
 *      isn't). We prefer "no policy at all" over "2 out of 3 policies"
 *      because the sub-org is going to be abandoned either way.
 *   2. Throws PolicyIncompleteError with the list of failing policy
 *      names so the provisioning caller can fail the whole transaction
 *      deterministically.
 *
 * After success, the helper queries listPolicies and verifies all three
 * baseline policy names are present -- a defence against Turnkey silently
 * accepting a createPolicy request that later doesn't materialise.
 */
export async function applyBaselinePolicies(
  client: ApiClient,
  subOrgId: string
): Promise<void> {
  const settled = await Promise.allSettled(
    BASELINE_POLICIES.map((p) =>
      client.createPolicy({
        organizationId: subOrgId,
        policyName: p.policyName,
        effect: p.effect,
        condition: p.condition,
        // Turnkey v5.3.0 requires a valid expression for consensus even on
        // EFFECT_DENY policies; the empty-string shortcut noted in the original
        // 33-RESEARCH.md Pitfall 7 was incorrect. "true" means "consensus is
        // always satisfied" — combined with EFFECT_DENY this unconditionally
        // denies the operation whenever the condition matches, which is the
        // intended GUARD-06 behaviour.
        consensus: "true",
        notes: p.notes,
      })
    )
  );

  const failures: string[] = [];
  const successes: { policyId: string; policyName: string }[] = [];
  const pairs = settled.map((result, idx) => ({
    result,
    policy: BASELINE_POLICIES[idx],
  }));
  for (const { result, policy } of pairs) {
    if (!policy) {
      continue;
    }
    if (result.status === "rejected") {
      failures.push(policy.policyName);
    } else {
      // createPolicy returns { activity: {...}, policyId: string }.
      const res = result.value as unknown as { policyId?: string };
      if (res?.policyId) {
        successes.push({
          policyId: res.policyId,
          policyName: policy.policyName,
        });
      }
    }
  }

  if (failures.length > 0) {
    // Best-effort rollback of any partial successes. Failures here are
    // non-fatal -- we are about to throw anyway, and the provisioning flow
    // must treat the sub-org as abandoned.
    await Promise.allSettled(
      successes.map((s) =>
        client.deletePolicy({
          organizationId: subOrgId,
          policyId: s.policyId,
        })
      )
    );
    throw new PolicyIncompleteError(subOrgId, failures);
  }

  // Post-condition: verify all three baseline policies are actually visible
  // on Turnkey's side. This catches the (rare but documented) case where
  // createPolicy succeeds but the policy is not yet queryable, and any
  // future regression where a silent failure would leave a gap.
  const listed = (await client.getPolicies({
    organizationId: subOrgId,
  })) as { policies?: { policyName: string; effect: string }[] };
  const presentNames = new Set(
    (listed.policies ?? []).map((p) => p.policyName)
  );
  const missing = BASELINE_POLICIES.filter(
    (p) => !presentNames.has(p.policyName)
  ).map((p) => p.policyName);
  if (missing.length > 0) {
    // Best-effort rollback then throw -- same semantics as the batch-failure
    // path above.
    await Promise.allSettled(
      successes.map((s) =>
        client.deletePolicy({
          organizationId: subOrgId,
          policyId: s.policyId,
        })
      )
    );
    throw new PolicyIncompleteError(subOrgId, missing);
  }
}
