"use client";

import { toHex } from "viem";
import type { Eip1193Provider } from "@/lib/wallet/connect-types";

/**
 * Client helpers for wallet step-up. When a step-up-gated endpoint returns
 * `signature_required` with a `challenge`, the connected wallet signs that
 * exact message and the request is retried with the signature.
 */

export type StepUpExtra = {
  signature?: string;
  code?: string;
  emailOtp?: string;
};

function getInjectedProvider(): Eip1193Provider {
  const injected = (window as unknown as { ethereum?: Eip1193Provider })
    .ethereum;
  if (!injected) {
    throw new Error("No wallet detected in this browser.");
  }
  return injected;
}

/** Sign a step-up challenge with the connected wallet (EIP-191 personal_sign). */
export async function signStepUpChallenge(challenge: string): Promise<string> {
  const provider = getInjectedProvider();
  const accounts = await provider.request<string[]>({
    method: "eth_requestAccounts",
  });
  const address = accounts?.[0];
  if (!address) {
    throw new Error("No wallet account was authorized.");
  }
  return await provider.request<string>({
    method: "personal_sign",
    params: [toHex(challenge), address],
  });
}

type StepUpBody = { code?: string; challenge?: string };

/**
 * Runs a step-up-gated request. `send` performs the fetch with the given
 * extra fields. On a `signature_required` response the wallet signs the
 * returned challenge and the request is retried once. Returns the final
 * Response (the caller handles non-signature errors and success).
 */
export async function runWalletStepUp(
  send: (extra: StepUpExtra) => Promise<Response>
): Promise<Response> {
  const first = await send({});
  if (first.ok) {
    return first;
  }
  const data = (await first
    .clone()
    .json()
    .catch(() => ({}))) as StepUpBody;
  if (
    first.status === 401 &&
    data.code === "signature_required" &&
    data.challenge
  ) {
    const signature = await signStepUpChallenge(data.challenge);
    return await send({ signature });
  }
  return first;
}
