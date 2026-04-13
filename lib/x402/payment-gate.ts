import { createHash } from "node:crypto";
import type { RouteConfig } from "@x402/core/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type NewWorkflowPayment,
  organizationWallets,
  type WorkflowPayment,
  workflowPayments,
} from "@/lib/db/schema";
import type { CallRouteWorkflow } from "./types";

/**
 * Extracts the payer wallet address from a base64-encoded PAYMENT-SIGNATURE
 * header. The x402 protocol encodes the payment payload as base64 JSON with
 * a nested `payload.authorization.from` field (EIP-3009 exact scheme).
 *
 * Returns null when the header is missing or cannot be decoded - payment
 * recording should still succeed, just without the payer address.
 */
export function extractPayerAddress(paymentSig: string | null): string | null {
  if (!paymentSig) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(paymentSig, "base64").toString("utf-8")
    ) as { payload?: { authorization?: { from?: string } } };
    return decoded?.payload?.authorization?.from ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds the RouteConfig object for withX402().
 * Sets scheme "exact", network Base mainnet, and payTo as the creator wallet.
 * Price is formatted as "$N.NN" -- the dollar sign prefix is required by @x402/evm
 * to parse as USD and resolve the USDC contract automatically.
 * Does NOT set a custom token name to avoid Pitfall 5 (wrong token address resolution).
 */
export function buildPaymentConfig(
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string
): RouteConfig {
  const price = Number(workflow.priceUsdcPerCall);
  const publicHost =
    process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";
  return {
    accepts: {
      scheme: "exact",
      network: "eip155:8453",
      payTo: creatorWalletAddress,
      price: `$${price.toFixed(2)}`,
    },
    resource: `${publicHost}/api/mcp/workflows/${workflow.listedSlug}/call`,
    description: `Pay to run workflow: ${workflow.name}`,
  };
}

/**
 * Computes a SHA-256 hex digest of the raw PAYMENT-SIGNATURE header value.
 * Used as the idempotency key stored in workflow_payments.payment_hash.
 */
export function hashPaymentSignature(paymentSig: string): string {
  return createHash("sha256").update(paymentSig).digest("hex");
}

/**
 * Looks up an existing payment record by payment hash.
 * Returns the record if found (indicating a duplicate), or null if this is a new payment.
 */
export async function findExistingPayment(
  hash: string
): Promise<WorkflowPayment | null> {
  const rows = await db
    .select()
    .from(workflowPayments)
    .where(eq(workflowPayments.paymentHash, hash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Inserts a new payment record into workflow_payments.
 * On Postgres unique violation (code 23505), returns silently --
 * the idempotency check via findExistingPayment handles the response.
 */
export async function recordPayment(data: NewWorkflowPayment): Promise<void> {
  try {
    await db.insert(workflowPayments).values(data);
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "23505") {
      return;
    }
    throw err;
  }
}

/**
 * Resolves the creator wallet address for an organization.
 * Returns null when no wallet is registered for the org (workflow cannot accept payment).
 */
export async function resolveCreatorWallet(
  organizationId: string | null
): Promise<string | null> {
  if (organizationId === null) {
    return null;
  }
  const rows = await db
    .select({ walletAddress: organizationWallets.walletAddress })
    .from(organizationWallets)
    .where(eq(organizationWallets.organizationId, organizationId))
    .limit(1);
  return rows[0]?.walletAddress ?? null;
}
