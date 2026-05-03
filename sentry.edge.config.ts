// Sentry initialization for the Next.js edge runtime (middleware, edge routes).
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import { init } from "@sentry/nextjs";

const { SENTRY_DSN, SENTRY_ENVIRONMENT } = process.env;

if (SENTRY_DSN) {
  init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    // 1 = 100% of traces are sent
    tracesSampleRate: 1,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,
  });
}
