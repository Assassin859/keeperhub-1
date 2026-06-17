"use client";

/**
 * PendingScanRunner — layout-mounted client component that auto-resumes a
 * pending scan intent after sign-in.
 *
 * Mirrors components/hub/pending-template-runner.tsx exactly:
 * - Reads the pending_scan HttpOnly cookie via GET /api/auth/scan-intent
 *   (atomically cleared on read)
 * - Builds the workflow from the stored SuggestionDescriptor via buildWorkflow
 * - Creates the workflow via POST /api/workflows/create
 * - For schedule mode: PATCHes the workflow to sync the schedule
 * - Executes the workflow immediately
 * - Redirects to /workflows/[id] with a success toast
 *
 * Idempotency: sessionStorage TTL (30s) keyed by descriptor.id + inFlight ref
 * + server-side atomic cookie clear.
 *
 * NOT mounted in app/layout.tsx until Plan 54-03.
 * Implementation lands in Plan 54-03.
 */
export function PendingScanRunner(): null {
  return null;
}
