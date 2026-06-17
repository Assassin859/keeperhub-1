---
gsd_state_version: 1.0
milestone: v1.13
milestone_name: Scan-to-Automate Onboarding
status: executing
last_updated: "2026-06-17T11:08:21.150Z"
last_activity: 2026-06-17
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 18
  completed_plans: 14
  percent: 40
---

# Project State

## Project Reference

- **Core value:** Users can build and deploy Web3 automation workflows through a visual builder without writing code.
- **Current focus:** Phase 53 — scan-ui

## Current Position

Phase: 53 (scan-ui) — EXECUTING
Plan: 2 of 5
Status: Ready to execute
Last activity: 2026-06-17

## Performance Metrics

- Phases planned: 5 (51-55)
- Phases complete: 0
- Plans complete: 10/13 (51-01..51-06, 52-01, 52-02 done)
- Duration 51-01: 31 minutes
- Duration 51-02: ~20 minutes
- Duration 51-03: 27 minutes
- Duration 51-04: 7 minutes
- Duration 51-05: 10 minutes
- Duration 51-06: 7 minutes
- Duration 52-01: 10 minutes
- Duration 52-02: 4 minutes
- Duration 52-05: 12 minutes
- Duration 53-01: 5 minutes

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
- L2 wstETH: raw balance only — getStETHByWstETH not called on L2 bridges (A6 resolved, Phase 52 may add conversion) (51-06).
- Stablecoin adapter is pure over orchestrator-supplied token list; no direct DB query inside the adapter (51-06).
- decodeAaveV3Results does not check AAVE_V3_POOLS registry — decode is chainId-agnostic; registry used only in buildAaveV3Calls (51-05).
- resolveImplementationAddress takes provider directly (not chainId) for clean testability without getRpcProvider mock (51-05).
- EIP1967_IMPLEMENTATION_SLOT exported from proxy-detection.ts rather than re-implemented as a new literal (51-05).
- Wave 0 stubs required for type-check compliance: engine.ts / factory/index.ts / factory/validate.ts created as throw-stubs so pnpm type-check passes while RED tests land; Wave 2 replaces stubs with real implementations (52-01).
- clampHfThreshold: returns HF_DEFAULT (1.5) when currentHf > 1.5; Math.max(currentHf - 0.1, 1.3) otherwise; hard floor 1.3 never breached (52-02).
- hfThresholdRaw uses BigInt(Math.floor(threshold * 1e18)).toString() — safe for 1.3/1.5 because both are exactly representable IEEE 754 doubles at 1e18 scale (52-02).
- alert category built from supply-only Aave positions (healthFactor null, protocol !== lido); Lido null-HF positions route to claim only (52-02).
- suggestions? field is OPTIONAL on ScanResponse (type-only import from suggestions/types.ts) for backward compatibility with Phase 51 callers and cached rows pre-dating 52-05.
- buildSuggestions wrapped in inner try/catch in the route so any engine failure degrades to suggestions:[] rather than failing the 200 response (T-52-12, 52-05).
- Suggestions attached in the route (not inside scanAddress) — cached scan rows pre-dating 52-05 are unaffected; route computes fresh suggestions on each response.
- Token-first ordering: health badge tokens committed in 53-01 before any component references them, preventing token-audit failures during Wave 2 component commits (53-01).
- Local type aliases in E2E fixtures: mirrors ScanResponse shapes without importing from server-only lib/scan/types.ts; type-check passes via locally-defined structural equivalents (53-01).

### Todos

- Run `/gsd:plan-phase 51` to begin Phase 51: Scanner Infrastructure.

### Blockers

- None.

## Session Continuity

- Roadmap file: `.planning/ROADMAP.md`
- Requirements file: `.planning/REQUIREMENTS.md`
- Last shipped milestone: v1.12 (MCP n8n Pattern Borrows, phases 46-50, shipped 2026-05-18, never formalized in GSD)
- Last completed: 53-01 (health badge tokens + scan E2E scaffold: --color-badge-health-* tokens, scan.test.ts RED scaffold, ScanResponse fixture) — 2026-06-17
- Stopped at: Plan 1 of 5 (phase 53 plan 1 complete)
- Next command: `/gsd:execute-phase 53 02`

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
| scanner-infra | `pnpm check` Biome config error (`noIncrementDecrement` unknown key in biome.jsonc:58) — pre-existing, unrelated to plan 51-05 | deferred |
