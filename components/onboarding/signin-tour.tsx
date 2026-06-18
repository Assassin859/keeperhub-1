"use client";

import { useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import { isNewUserSession } from "@/lib/is-new-user";

const SEEN_KEY = "keeperhub-signin-tour-seen";
const ANCHOR_SELECTOR = '[data-tour="signin-button"]';
const ANCHOR_WAIT_MS = 5000;

function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "true";
  } catch {
    // Storage blocked (Safari private mode); treat as not seen.
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "true");
  } catch {
    // Storage unavailable; the tour may simply reappear next visit.
  }
}

// The Sign In button mounts only after the session resolves, so the anchor can
// be absent for a tick after this component runs. Resolve once it appears, or
// null if it never shows within the timeout / the effect is torn down.
function waitForAnchor(signal: AbortSignal): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
    if (existing) {
      resolve(existing);
      return;
    }

    let observer: MutationObserver;
    let timeoutId: number;
    let settled = false;

    const finish = (element: HTMLElement | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeoutId);
      resolve(element);
    };

    observer = new MutationObserver(() => {
      const element = document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
      if (element) {
        finish(element);
      }
    });
    timeoutId = window.setTimeout(() => {
      finish(null);
    }, ANCHOR_WAIT_MS);

    signal.addEventListener("abort", () => finish(null), { once: true });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * One-card intro.js tour pointing new visitors at the Sign In button. Shows once
 * per browser (persisted in localStorage) and never for signed-in users.
 */
export function SignInTour(): null {
  const { data: session, isPending } = useSession();
  const startedRef = useRef(false);

  useEffect(() => {
    if (isPending || startedRef.current) {
      return;
    }
    if (!isNewUserSession(session) || hasSeenTour()) {
      return;
    }

    startedRef.current = true;
    const controller = new AbortController();

    const startTour = async (): Promise<void> => {
      const anchor = await waitForAnchor(controller.signal);
      if (!anchor || controller.signal.aborted) {
        return;
      }

      const { default: introJs } = await import("intro.js");
      if (controller.signal.aborted) {
        return;
      }

      const tour = introJs.tour();
      tour.setOptions({
        steps: [
          {
            element: anchor,
            title: "Sign in to get started",
            intro:
              "Create an account to save your workflows and unlock the full hub.",
          },
        ],
        showBullets: false,
        showStepNumbers: false,
        showProgress: false,
        doneLabel: "Got it",
      });
      tour.onComplete(() => markSeen());
      tour.onExit(() => markSeen());
      await tour.start();
    };

    startTour().catch(() => {
      // intro.js failed to load or start; skip the tour silently.
    });

    return () => {
      controller.abort();
    };
  }, [session, isPending]);

  return null;
}
