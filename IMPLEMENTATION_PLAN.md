# KEEP-612 Detection Layer v0 — Substrate

Build the prerequisites that the Detection v0 ticket implicitly assumes exist, so the actual alert rules become trivial follow-ups.

## Context

KEEP-612 proposes four detection bullets on top of KEEP-615 (signup redesign). Two of them have no emit point in the current code:

- **Content-pattern alerts on node config/payloads** — no scanner exists. `lib/safe-fetch.ts` only inspects destinations.
- **Behavioral (new-account→workflow, throughput spike, API-key off-hours/new-ASN)** — `workflow_executions` has no `api_key_id` or source IP column, so there's nothing to group on.

The other two only need a single Sentry capture line + a Loki rule, but the trigger landscape has shifted since the ticket was written:

- `block_user_signup` trigger was dropped in `drizzle/0086_*` — that v0 bullet is partly stale. Only `block_executions_for_inactive_workflows` remains.
- Better Auth `session.create.before` hook (`lib/auth.ts:418-424`) silently returns `false` on deactivated login — no Sentry/Loki signal today.

This branch builds the substrate end-to-end so v0 alerts can ship as one or more small follow-up PRs.

## Stage 1: Execution attribution
**Goal**: Every `workflow_executions` row records who/how/from-where it was triggered.
**Changes**:
- Migration `0088_workflow_execution_attribution`: add nullable columns `triggered_by_api_key_id` (FK → `api_keys.id` ON DELETE SET NULL), `triggered_by_ip` (text), `trigger_source` (text: `manual` | `schedule` | `webhook` | `mcp` | `api`)
- Drizzle schema update + `_journal.json` entry with monotonic `when` > 1779670685294
- Thread attribution from entry points into the execution insert:
  - `app/api/workflows/[id]/execute` (manual / API)
  - Webhook handlers (`wfb_` user keys)
  - Schedule runner
  - MCP execution entry
- Helper: `lib/security/attribution.ts` to extract `(api_key_id, ip, source)` from a `Request`
**Success criteria**:
- `pnpm db:migrate` applies cleanly against a `db:push`-bootstrapped local DB (per CLAUDE.md backfill note)
- New executions populate all three columns; existing rows stay NULL (no backfill)
- `pnpm check`, `pnpm type-check`, `pnpm test` green
**Tests**: Unit tests for `attribution.ts` (header parsing, IP extraction, CF `cf-connecting-ip` precedence); integration test asserting a manual execute and a webhook execute both write attribution rows.
**Status**: Complete — migration 0088 + schema columns + helper `lib/security/request-attribution.ts` + 4 insert sites updated + 10 unit tests passing

## Stage 2: Backstop & auth signals
**Goal**: Every backstop-trigger reject and every deactivated-login attempt emits a structured Sentry event with enough context to alert and triage.
**Changes**:
- `lib/auth.ts` `session.create.before` hook: add `Sentry.captureMessage("security.deactivated_login_attempt", { level: "warning", user: { id }, extra: { ip, userAgent } })` before returning `false`. Same treatment for the OAuth `account.create.before` hook.
- New helper `lib/security/backstop-capture.ts` that wraps `workflow_executions` INSERT: catches `error.code === '42501'` with message matching the backstop trigger, emits `Sentry.captureMessage("security.backstop_execution_blocked", { ... })` with `(user_id, workflow_id, source)`, then rethrows.
- Drop the `block_user_signup` references from the plan — it was removed in migration 0086. Note in PR description.
**Success criteria**:
- Forcing a deactivated-login attempt in dev produces exactly one Sentry event with the expected tags
- Forcing a workflow-execute as a deactivated user produces exactly one `security.backstop_execution_blocked` event; original `42501` still propagates to caller
- No double-capture (don't capture once at hook + once at app catch)
**Tests**: Unit test for `backstop-capture.ts` (asserts capture called once with expected payload, asserts rethrow); extend `tests/integration/auth-deactivation-guard.test.ts` to assert the capture fires.
**Status**: Complete — Sentry captures in both auth hooks + `lib/security/backstop-capture.ts` wrapping all 4 insert sites + 8 unit tests passing. Sentry transport failure does not shadow original error (verified by test).

## Stage 3: Content-pattern scanner
**Goal**: Pre-execution scan of every node config emits a Sentry event when a suspicious pattern is found. Alert-only; no blocking in v0.
**Changes**:
- New `lib/security/content-scanner.ts` exporting `scanNodeConfig(config: unknown): ScanHit[]`
- Pattern list (compiled regex, case-insensitive where meaningful): `169.254.169.254`, `\binformation_schema\b`, `\bpg_catalog\b`, `\bneon_auth\b`, `\brefresh_token\b`, `\bclient_secret\b`, `\bDATABASE_URL\b`
- Recursively walks string leaves of the config JSON; returns `{ pattern, jsonPath, snippet }` where `snippet` is a redacted 40-char window so the alert is actionable without leaking secrets
- Hook into `lib/workflow/executor/executor.workflow.ts` immediately before each node's execute step; emits one `Sentry.captureMessage("security.content_scanner_hit", ...)` per node per execution (deduped within the run) with `(workflow_id, execution_id, node_id, node_type, hits[].pattern)` — never `hits[].snippet`
- Env flag `CONTENT_SCANNER_ENFORCE=true` reserved for a future PR to convert to block; default off
**Success criteria**:
- Unit table-test covers each pattern: positive match in URL, header value, body field, nested object; verified non-matches for safe text containing partial substrings
- Per-node scan time < 1ms p99 on a 10KB config (benchmark in test)
- Sentry event payload reviewed for absence of pattern values / credentials
- Integration test: seed a workflow with `endpoint: "http://169.254.169.254/..."` and assert the event fires on execute
**Tests**: As above + executor integration test.
**Status**: Complete — `lib/security/content-scanner.ts` + scanAndReport hook in `executor.workflow.ts:1591` + 17 unit tests covering each pattern, dedup, and the no-leak-of-matched-value invariant. Pre-existing tech debt in executor.workflow.ts (6 errors, 10 warnings) unchanged from HEAD.

## Stage 4: Wire alerts
**Goal**: The Sentry events and existing metrics actually reach a person.
**Changes** (in `/Users/chong/techops/techops_infrastructure`):
- New Loki alert module(s) mirroring the Ajna pattern in `prod/eks-cluster/alerts.tf`:
  - `security.deactivated_login_attempt` — alert on any occurrence (low rate expected)
  - `security.backstop_execution_blocked` — alert on any occurrence
  - `security.content_scanner_hit` — alert on any occurrence
- Grafana alert on `safe_fetch.blocks.total` metric (already emitted by `lib/safe-fetch.ts`); threshold tuned after baseline observation
- Set `SAFE_FETCH_ENFORCE=true` in prod env (flips shadow → enforce; signal already wired)
- Route: TBD — see open questions
**Success criteria**:
- `terraform plan` clean; only adds resources
- Synthetic log injection in staging fires each alert as expected
- On-call docs entry for each alert with triage steps
**Tests**: Synthetic injection via `logger.warn` in staging; verify alert fires; verify routing.
**Status**: Complete — `techops_infrastructure/alerts.tf` adds `keeperhub_security_signal_alerts` module with three Loki rules (`security.deactivated_login_attempt`, `security.backstop_execution_blocked`, `security.content_scanner_hit`). All three capture sites in the keeperhub repo now dual-emit (Sentry + structured `console.warn`) so the signal reaches Loki even when SENTRY_DSN is unset. Pagerduty escalation name `KeeperhubSecurityPagerduty` is a placeholder — needs to be created in PD before `terraform apply` will succeed. `SAFE_FETCH_ENFORCE=true` flip and the metric-based alert on `safe_fetch.blocks.total` are deferred to a separate small PR (env change + dashboard rule, no app code).

## Open questions (resolve before Stage 4, don't block 1–3)

1. **Alert routing**: PagerDuty (new service?), Slack channel, both? Existing `alerts.tf` only has Ajna Keeper PD. Need a security on-call destination.
2. **Webhook IP attribution**: Behind Cloudflare — confirm we use `cf-connecting-ip` not `x-forwarded-for` for the canonical IP.
3. **Content scanner false-positive budget**: any known workflows that legitimately use words like `client_secret` (e.g. an OAuth setup integration's display copy)? Need a one-pass scan of prod configs before turning the alert noisy.
4. **`SAFE_FETCH_ENFORCE` flip**: separate small PR or rolled in? Recommend separate so it can be reverted independently.

## Out of scope (defer)

- Behavioral alerts themselves (new-account→workflow rate, ASN tracking) — Stage 1 unblocks these but they're separate rules
- API key audit log table — `triggered_by_api_key_id` on `workflow_executions` covers the most-asked question ("which key ran this?"); a dedicated audit table can come later if needed
- ASN enrichment pipeline — needs a GeoIP/ASN data source decision (MaxMind, Cloudflare headers, etc.)
- Converting `content-scanner` from alert-only to blocking — explicit follow-up after baseline noise is understood
