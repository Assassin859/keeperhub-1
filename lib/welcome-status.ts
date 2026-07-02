// Client-only flags that drive the welcome experience. These are onboarding UX
// only -- not a security gate -- so localStorage is sufficient, mirroring the
// getting-started guide's `keeperhub-onboarding-guide` persistence pattern.

const WELCOME_SEEN_KEY = "keeperhub-welcome-seen";
const CONTINUE_AS_GUEST_KEY = "keeperhub-continue-as-guest";

function readFlag(key: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private-mode / storage-disabled: the flow still works, the wall just
    // re-shows on reload. Nothing to recover here.
  }
}

/** True once the signed-in user has finished or skipped the welcome wizard. */
export function hasSeenWelcome(): boolean {
  return readFlag(WELCOME_SEEN_KEY);
}

export function markWelcomeSeen(): void {
  writeFlag(WELCOME_SEEN_KEY);
}

/**
 * Persists onboarding completion server-side so the wizard is not shown again
 * on another device or browser. Fire-and-forget: the local flag already guards
 * this device, so a failed request is not fatal.
 */
export function markOnboardingComplete(): void {
  if (typeof window === "undefined") {
    return;
  }
  fetch("/api/user/onboarding/complete", { method: "POST" }).catch(() => {
    // Best-effort; the local welcome-seen flag still guards this device.
  });
}

/** True once the user chose "Continue without an account" on the welcome page. */
export function isContinueAsGuest(): boolean {
  return readFlag(CONTINUE_AS_GUEST_KEY);
}

export function markContinueAsGuest(): void {
  writeFlag(CONTINUE_AS_GUEST_KEY);
}
