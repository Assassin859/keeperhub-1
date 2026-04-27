// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import {
  captureRouterTransitionStart,
  type ErrorEvent,
  init,
} from "@sentry/nextjs";

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;

// Wallet providers (EIP-1193) reject with plain `{ code, message }` objects
// rather than Error instances, producing unhandled rejections with no stack.
// These are not actionable, so drop them at ingest.
function isEip1193ProviderRejection(event: ErrorEvent): boolean {
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
function hasNoInAppFrames(event: ErrorEvent): boolean {
  const frames = event.exception?.values?.[0]?.stacktrace?.frames;
  if (!frames || frames.length === 0) {
    return false;
  }
  return !frames.some((frame) => frame.in_app === true);
}

if (SENTRY_DSN) {
  init({
    dsn: SENTRY_DSN,
    ...(SENTRY_ENVIRONMENT && { environment: SENTRY_ENVIRONMENT }),

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    // 1 = 100% of traces are sent
    tracesSampleRate: 1,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,

    beforeSend(event) {
      if (isEip1193ProviderRejection(event)) {
        return null;
      }
      if (hasNoInAppFrames(event)) {
        return null;
      }
      return event;
    },
  });
}

export const onRouterTransitionStart = captureRouterTransitionStart;
