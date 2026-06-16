---
gsd_state_version: 1.0
milestone: v1.13
milestone_name: Scan-to-Automate Onboarding
status: executing
last_updated: "2026-06-17T00:20:00Z"
last_activity: 2026-06-17
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 8
  completed_plans: 4
  percent: 0
---

# Project State

## Project Reference

- **Core value:** Users can build and deploy Web3 automation workflows through a visual builder without writing code.
- **Current focus:** Phase 51 — scanner-infrastructure

## Current Position

Phase: 51 (scanner-infrastructure) — EXECUTING
Plan: 5 of 8
Status: Executing Phase 51
Last activity: 2026-06-17 -- Completed 51-04 (Chainlink + DefiLlama USD pricing layer)

## Performance Metrics

- Phases planned: 5 (51-55)
- Phases complete: 0
- Plans complete: 4/8 (51-01, 51-02, 51-03, 51-04 done)
- Duration 51-01: 31 minutes
- Duration 51-02: ~20 minutes
- Duration 51-03: 27 minutes
- Duration 51-04: 7 minutes

## Accumulated Context

### Decisions (already locked, do NOT re-debate during planning)

- Detection is hybrid: KeeperHub registry + Multicall3 reads FIRST, Zerion REST API as breadth fallback. No new npm packages; one new env var `ZERION_API_KEY`.
- Prefill is DETERMINISTIC (parameterized workflow factory, ~6 shapes covering 4 categories + generic fallback). NO AI generation in v1.13.
- Stablecoin idle-yield is MONITOR/DISPLAY ONLY in v1.13 (read-only). Write auto-deposit path deferred.
- Anonymous funnel: scan + suggestions require zero signup; sign-in gates only run/save. All rate-limiting + scan cache is Postgres-backed (not in-memory) for multi-pod correctness.
- USD pricing: Chainlink feeds for majors + DefiLlama for the rest; stablecoins priced from Chainlink (never hardcoded $1.00) with depeg detection.
- New `lib/scan/` module inserted between existing RPC infra and existing canvas/auth rails; touches only three existing files (schema additive, layout one line, new migration).
- `pending_scan` HttpOnly cookie mirrors `pending_template` pattern exactly; `PendingScanRunner` mirrors `PendingTemplateRunner`.
- Zerion used as breadth fallback only — never replaces native adapters for Aave, Compound, Lido, Spark (those have native adapters with better fidelity).
- Phase 51 builds Aave V3 + Lido adapters first (highest-signal for suggestion quality); remaining adapters (Compound V3, Spark, Sky) land in Phase 52.
- Multicall3 batches all reads per chain into one `eth_call` (one round-trip per chain); `Promise.allSettled` across chains.
- Per-chain timeout: 4s. Scan cache TTL: 5 minutes in-process check; cron sweeper deletes rows older than 1 hour.
- Write-type prefills must use exact (non-MaxUint256) approval amounts; server validator blocks MaxUint256 in scan-generated workflows (PREFILL-07).
- ProtocolAdapter uses pure buildCalls/decode shape (no class instantiation); orchestrator owns the multicall batch (51-01).
- L2 Chainlink stablecoin feeds omitted from registry (multiple candidate addresses); DefiLlama fallback applies for all L2 stablecoin pricing (51-01).
- BigInt() constructor used in tests instead of n-suffix literals for ES2017 tsconfig compatibility (51-01).
- aggregate3 (not tryAggregate or aggregate) used for Multicall3 batching — per-call allowFailure is embedded in each call struct (51-03).
- AbortController races via Promise.race in scanWithTimeout; clearTimeout in finally ensures cleanup on both fast-resolve and abort paths (51-03).
- isDepegged uses inclusive >= 0.005 threshold; IEEE 754 means price exactly 1.005 evaluates as non-depegged — plan test cases use 1.005000001 to sidestep this (51-04).
- resolveUsdPrice opts.chainlinkResult pattern: orchestrator pre-fetches Chainlink via aggregate3 and passes decoded MulticallResult; no independent RPC from pricing layer (51-04).

### Todos

- Run `/gsd:plan-phase 51` to begin Phase 51: Scanner Infrastructure.

### Blockers

- None.

## Session Continuity

- Roadmap file: `.planning/ROADMAP.md`
- Requirements file: `.planning/REQUIREMENTS.md`
- Last shipped milestone: v1.12 (MCP n8n Pattern Borrows, phases 46-50, shipped 2026-05-18, never formalized in GSD)
- Last completed: 51-04 (Chainlink + DefiLlama USD pricing layer) — 2026-06-17
- Stopped at: Plan 5 of 8 ready to execute
- Next command: `/gsd:execute-phase 51 05`

## Deferred Items

Items carried forward from v1.11 close and v1.12 (informal):

| Category | Item | Status |
|----------|------|--------|
| feature | MARKET-FUTURE-01..04 (earnings sort, time-window filters, materialized stats, per-row vote) | deferred to v1.11.x or later |
| feature | HUB-FUTURE-02 (per-tag OG image generation) | deferred |
| testing | Cross-browser CI runs (Firefox + WebKit) | deferred — Chromium-only by default |
| upstream | Next.js bfcache hydration race upstream issue/PR | deferred per Phase 45 ADR |
| v1.13 future | AI-generated prefill path for exotic/long-tail positions | deferred — no-AI-in-prefill decision in v1.13 |
| v1.13 future | Stablecoin idle-yield WRITE path (auto-deposit via Turnkey) | deferred |
| v1.13 future | Category-4 auto-claim WRITE workflows | deferred |
| v1.13 future | Additional protocol adapters (Morpho, Curve, Pendle, Yearn, Aerodrome) | deferred |
| v1.13 future | Shareable scan-result URLs (with privacy consent) | deferred |
