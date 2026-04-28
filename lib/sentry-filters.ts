// Predicates used by Sentry's beforeSend hook to drop benign or
// unactionable events at ingest. Kept in their own module so they can be
// unit-tested without re-running Sentry's init() side effects.

import type { ErrorEvent } from "@sentry/nextjs";

// Wallet providers (EIP-1193) reject with plain `{ code, message }` objects
// rather than Error instances, producing unhandled rejections with no stack.
// These are not actionable, so drop them at ingest.
export function isEip1193ProviderRejection(event: ErrorEvent): boolean {
  const mechanismType = event.exception?.values?.[0]?.mechanism?.type;
  if (!mechanismType?.includes("onunhandledrejection")) {
    return false;
  }
  const serialized = (event.extra as { __serialized__?: unknown } | undefined)
    ?.__serialized__;
  if (!serialized || typeof serialized !== "object") {
    return false;
  }
  const asRecord = serialized as Record<string, unknown>;
  return (
    typeof asRecord.code === "number" && typeof asRecord.message === "string"
  );
}

// Browser extensions (wallet shims, ad blockers, etc.) inject scripts into the
// page and throw errors that surface to window.onerror. They show up in Sentry
// with stacktraces composed entirely of non-app frames (`injected.js`,
// `injectedScript.bundle.js`, vendor shims). Drop events where the SDK marked
// every frame as out-of-app — they're third-party noise we can't fix.
export function hasNoInAppFrames(event: ErrorEvent): boolean {
  const frames = event.exception?.values?.[0]?.stacktrace?.frames;
  if (!frames || frames.length === 0) {
    return false;
  }
  return !frames.some((frame) => frame.in_app === true);
}

// `@monaco-editor/react` rejects with a `CancellationError` ("Canceled") when
// its loader/dispose chain unwinds before the editor finishes mounting — for
// example when the user navigates away from `/workflows/:workflowId` quickly.
// The rejection is benign (the editor is already gone) but bubbles to
// `window.onunhandledrejection` and pollutes Sentry. Filter it out at ingest.
export function isMonacoCancellation(event: ErrorEvent): boolean {
  const exception = event.exception?.values?.[0];
  const mechanismType = exception?.mechanism?.type;
  if (!mechanismType?.includes("onunhandledrejection")) {
    return false;
  }
  return exception?.value === "Canceled" && exception?.type === "Canceled";
}
