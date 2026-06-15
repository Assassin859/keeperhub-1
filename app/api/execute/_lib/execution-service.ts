import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { directExecutions } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

type CreateExecutionParams = {
  organizationId: string;
  apiKeyId: string;
  type: string;
  network?: string;
  input: Record<string, unknown>;
};

type CompleteParams = {
  transactionHash?: string;
  transactionLink?: string;
  gasUsedWei?: string;
  gasPriceWei?: string;
  estimatedCostUsd?: string;
  output?: Record<string, unknown>;
};

export async function createExecution(
  params: CreateExecutionParams
): Promise<{ executionId: string }> {
  const id = generateId();

  await db.insert(directExecutions).values({
    id,
    organizationId: params.organizationId,
    apiKeyId: params.apiKeyId,
    type: params.type,
    network: params.network ?? null,
    // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
    input: params.input as any,
    status: "pending",
  });

  return { executionId: id };
}

export async function markRunning(executionId: string): Promise<void> {
  await db
    .update(directExecutions)
    .set({ status: "running" })
    .where(eq(directExecutions.id, executionId));
}

export async function completeExecution(
  executionId: string,
  result: CompleteParams
): Promise<void> {
  await db
    .update(directExecutions)
    .set({
      status: "completed",
      transactionHash: result.transactionHash ?? null,
      gasUsedWei: result.gasUsedWei ?? null,
      gasPriceWei: result.gasPriceWei ?? null,
      estimatedCostUsd: result.estimatedCostUsd ?? null,
      // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
      output: (result.output ?? {}) as any,
      completedAt: new Date(),
    })
    .where(eq(directExecutions.id, executionId));
}

export async function failExecution(
  executionId: string,
  error: string
): Promise<void> {
  await db
    .update(directExecutions)
    .set({
      status: "failed",
      error,
      completedAt: new Date(),
    })
    .where(eq(directExecutions.id, executionId));
}

export async function setRetryCount(
  executionId: string,
  count: number
): Promise<void> {
  await db
    .update(directExecutions)
    .set({ retryCount: count })
    .where(eq(directExecutions.id, executionId));
}

const SENSITIVE_FIELDS = ["privateKey", "secret", "password", "mnemonic"];

export function redactInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  const redacted = { ...input };

  if (typeof redacted.abi === "string" && redacted.abi.length > 100) {
    redacted.abi = `${redacted.abi.slice(0, 100)}... (truncated)`;
  }

  for (const key of SENSITIVE_FIELDS) {
    if (key in redacted) {
      redacted[key] = "[REDACTED]";
    }
  }

  return redacted;
}

/**
 * Records a signer override the caller supplied but the route did not honor.
 *
 * Org-custodied direct executions always resolve the signer via org policy, so
 * a caller-supplied `web3Connection` (the per-node signer-mode selector) never
 * influences the write. We still want it in the audit log -- a smuggled
 * `web3Connection: "eoa"` is a bypass attempt worth seeing -- but it must not
 * sit at the top level where a reader could mistake it for a value that took
 * effect. This moves any top-level `web3Connection` out of `auditBase` and
 * records it under `_rejectedConfig` instead, keying off the caller's original
 * request so it works whether or not `auditBase` has already been stripped.
 */
export function withRejectedSignerOverride(
  auditBase: Record<string, unknown>,
  callerConfig: Record<string, unknown>
): Record<string, unknown> {
  if (!("web3Connection" in callerConfig)) {
    return auditBase;
  }
  const { web3Connection: _omit, ...base } = auditBase;
  return {
    ...base,
    _rejectedConfig: { web3Connection: callerConfig.web3Connection },
  };
}
