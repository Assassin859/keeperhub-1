"use client";

import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { authClient, useSession } from "@/lib/auth-client";
import {
  useInvalidateWalletInfo,
  useWalletInfo,
} from "@/lib/wallet/use-wallet-info";

type ProvisionEvent =
  | { type: "provisioning" }
  | { type: "ready"; walletAddress: string; created: boolean }
  | { type: "error"; message: string };

/**
 * Orgs whose provisioning stream has already been opened this page-session.
 * Module-level so the multiple mounted consumers (the global trigger plus the
 * workflow toolbar) never open the stream twice for the same org.
 */
const attemptedOrgIds = new Set<string>();

/** Shared so the toolbar badge reflects provisioning regardless of which mounted hook opened the stream. */
const provisioningAtom = atom(false);

function parseEvent(frame: string): ProvisionEvent | null {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) {
    return null;
  }
  try {
    return JSON.parse(dataLine.slice(5).trim()) as ProvisionEvent;
  } catch {
    return null;
  }
}

async function runProvisionStream(onReady: () => void): Promise<void> {
  const response = await fetch("/api/user/wallet/provision");
  if (!(response.ok && response.body)) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), {
      stream: !done,
    });

    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const event = parseEvent(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      if (event?.type === "ready") {
        onReady();
      }
      separator = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Drives signup-time wallet provisioning from the client: when a verified user
 * has an active org but no wallet yet, opens the streamed provisioning endpoint
 * once, awaits the Turnkey call, and refreshes wallet info when it is ready.
 * Self-gating and idempotent - safe to mount in global chrome. On failure it
 * stays silent; the next-login backstop (session.create.after) is the fallback.
 */
export function useWalletProvisioning(): { isProvisioning: boolean } {
  const { data: session } = useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { hasWallet, isLoading } = useWalletInfo();
  const invalidate = useInvalidateWalletInfo();
  const isProvisioning = useAtomValue(provisioningAtom);
  const setProvisioning = useSetAtom(provisioningAtom);

  const email = session?.user?.email;
  const isAuthed =
    !!session?.user?.id &&
    !!email &&
    !email.startsWith("temp-") &&
    session?.user?.emailVerified === true;
  const activeOrgId = activeOrg?.id ?? null;

  useEffect(() => {
    if (!(isAuthed && activeOrgId)) {
      return;
    }
    // Wait for the wallet-status fetch to resolve before deciding.
    if (isLoading || hasWallet) {
      return;
    }
    if (attemptedOrgIds.has(activeOrgId)) {
      return;
    }

    attemptedOrgIds.add(activeOrgId);
    setProvisioning(true);
    runProvisionStream(invalidate)
      .catch(() => {
        // Network/stream failure: fall back silently to the login backstop.
      })
      .finally(() => {
        setProvisioning(false);
      });
  }, [
    isAuthed,
    activeOrgId,
    isLoading,
    hasWallet,
    invalidate,
    setProvisioning,
  ]);

  return { isProvisioning };
}
