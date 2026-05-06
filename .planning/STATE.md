---
gsd_state_version: 1.0
milestone: none-active
milestone_name: —
status: between_milestones
last_updated: "2026-05-06T00:00:00.000Z"
last_activity: 2026-05-06
last_shipped_milestone: v1.11
last_shipped_milestone_name: Marketplace Discovery & Hub UX
last_shipped_date: 2026-05-01
progress:
  total_phases: 4
  completed_phases: 4
  total_plans: 42
  completed_plans: 42
  percent: 100
---

# Project State

## Project Reference

- **Core value:** Users can build and deploy Web3 automation workflows through a visual builder without writing code.
- **Current focus:** Between milestones — v1.11 closed 2026-05-06; next via `/gsd-new-milestone`.

## Current Position

Phase: — (no active milestone)
Plan: —

- **Phase:** —
- **Plan:** —
- **Status:** v1.11 milestone closed 2026-05-06 — 4/4 phases shipped, archived to `.planning/milestones/v1.11-{ROADMAP,REQUIREMENTS}.md`, git tag `v1.11` created locally (not pushed). Audit verdict `tech_debt` accepted: Phase 42 manual UAT (42-10) and Phase 43 retrospective VERIFICATION.md remain as documentation tracking debt.
- **Last activity:** 2026-05-06 — v1.11 milestone close finalization

## Performance Metrics

- Phases planned: 3
- Phases complete: 0
- Plans complete: 4/—
- Plan 43-01 — 3 tasks, 4 files modified, ~10 min, 8/8 unit tests pass
- Plan 43-02 — 2 tasks, 6 files created, ~6 min, type-check green; 26/26 unit tests pass (sitemap-robots + hub-tag-route + reserved-slugs); 0 token-audit errors introduced
- Plan 43-03 — 1 task, 1 file modified, ~4 min, lint + type-check + token-audit green
- Plan 43-04 — 1 task, 1 file modified, ~3 min, type-check green; lint + token-audit baseline blocked (pre-existing, not introduced)
- Plan 43-06 — 4 tasks, 6 files (4 created + 2 modified), ~5 min, type-check green; token-audit error count unchanged (zero introduced)
- Plan 43-07 — 3 tasks, 4 files (2 created + 2 modified), ~5 min, type-check green; biome clean on touched files; token-audit unchanged at 6 errors (zero introduced); two new design tokens declared (--ds-row-stripe, --color-row-stripe)
- Plan 43-05 — 4 tasks, 7 files (3 created + 4 modified including .npmrc env fix), ~12 min, type-check green; biome clean on touched files; token-audit unchanged at 6 errors (zero introduced); 9/9 vitest tests added for the new route handler
- Plan 43-09 — 4 tasks, 4 files (3 created + 1 extended), ~5 min, type-check green; biome clean on touched files; reserved-slugs unit suite expanded to 32/32 passing; 3 new Playwright suites (hub-tag-route, hub-view-toggle, hub-use-template-anon) authored — full E2E execution deferred to plan 43-10 UAT
- Plan 43-11 — 2 tasks, 2 files modified, ~3 min, type-check green; biome clean on touched files; token-audit unchanged at 6 errors (zero introduced); UAT gaps #1 (sidebar redesign) and #2 (sidebar position under Templates divider) closed
- Plan 43-12 — 2 tasks, 1 file modified, ~2 min, type-check green; biome clean on touched files; token-audit unchanged (zero new errors in workflow-template-card.tsx); UAT gaps #5 (vote+Featured to bottom — overrides CONTEXT.md top-right decision) and #6 (tile hover matches protocol-card hover:brightness-125) closed
- Plan 43-14 — 3 tasks (committed across 2 atomic commits — Tasks 2+3 merged due to interlocked SortValue type widening), 4 files modified, ~3 min, type-check green; biome clean on touched files; token-audit unchanged at 6 errors (zero introduced); UAT gap #7 (Sort options expansion to Most used / Featured / Top rated / Name with default Most used) closed; new duplicateCount aggregate exposed on /api/workflows/public via workflows.sourceWorkflowId referrer count
- Plan 43-13 — 2 tasks, 2 files modified, ~3 min, type-check green; biome clean on touched files; token-audit unchanged at 6 errors (zero new errors in touched files); UAT gap #3 (inline tag-pill row removal) and gap #4 (smooth tag navigation via useTransition + router.push, scroll preserved) closed
- Plan 44-12 — 3 tasks, 3 code files modified + 2 .planning artifacts (UAT.md + 12-SUMMARY.md, both gitignored), ~30 min, type-check green; biome clean on all 21 Phase-44 touched files (24 introduced lint errors auto-fixed via top-level regex extraction); 18/18 e2e tests pass (`tabbed-hub|marketplace` grep); 4 discovery probes captured; 11/11 manual cases human-verified live in real Chrome via MCP; UAT verdict GREEN (44-12)
- Requirements mapped: 60/60 (excluding TEST-01..03 which are cross-cutting on every phase)
- Requirements completed: HUB-01..HUB-25, TEST-02, HUBV2-01..HUBV2-08, MARKET-01..MARKET-09, MARKET-11..MARKET-13, TEST-01, TEST-03 (47/60; MARKET-10 SUPERSEDED by HUBV2-08; remaining open items belong to Foundations [MODAL-01..08, SEC-01..06, NAV-01..08] + HUB-07 + HUB-15 [Phase 42] + HUB-22)

## Accumulated Context

### Decisions (already locked, do NOT re-debate during planning)

- Marketplace lives as the third TAB on `/hub` (NOT a standalone `/marketplace` route — this overrides the original v1.11 plan; ROADMAP rewritten in commit `adc9632f`; shipped in Phase 44)
- Tag URLs use `/hub/tags/[tag]` path segment (NOT `?tag=` query)
- Phase 44 ships popularity-only sort; earnings sort deferred to v1.11.x or later (privacy review pending)
- Zero new npm dependencies needed
- View toggle persisted in cookie (NOT localStorage)
- Single `WorkflowIOOverlay` with shadcn Tabs (NOT two side-by-side overlays)
- Import schema hardened (`.passthrough()` -> `.strict()`) as part of Phase 42
- Phase 43 + Phase 44 require `/frontend-design:frontend-design` skill during planning
- One PR per phase, all targeting `staging`
- Reserved-slug validator centralized in `@/lib/workflow/reserved-slugs` and reused by both `workflows.listedSlug` (workflow PATCH) and `publicTags.slug` (public-tags POST). Validator has zero imports for clean tree-shaking; HUB-15 error copy `"{slug}" is a reserved word and cannot be used.` is the binding contract for both routes.
- Use-template CTA dark foreground uses existing `--color-bg-inverse` token — no new `--color-on-accent-text` token needed (UI-SPEC §Open Issues #2 resolved). Toast copy after duplicate succeeds: `Template ready in your workflows` (UI-SPEC Copywriting Contract).
- HubViewToggle uses a manual WAI-ARIA radiogroup (two `<button role="radio">` with arrow-key handling) NOT `@radix-ui/react-toggle-group` — keeps zero-new-deps promise; UI-SPEC §Open Issues #1 resolved (43-06).
- `hub_view` cookie is NOT HttpOnly — explicit per CONTEXT.md HUB-19 to allow client-side fallback reads (43-06).
- `app/hub/page.tsx` is now a server component reading `cookies()`; client logic lives in `app/hub/_view-shell.tsx` (underscore prefix avoids creating a route segment) — pattern reused by `app/hub/tags/[tag]/page.tsx` when that route lands.
- `/hub/tags/[tag]` route is server-rendered with `generateStaticParams` (build-time prerender of every public tag) + `dynamicParams=true` + `revalidate=3600` (on-demand ISR for tags added after deploy). Reserved slugs and unknown slugs both 404 via `notFound()`. Empty tag pages emit `robots: { index: false, follow: true }` instead of 404 (43-02).
- `app/sitemap.ts` and `app/robots.ts` now exist as Next.js metadata routes; sitemap enumerates `publicTags` rows; robots disallows `/hub?` and `/marketplace?` query-string variants (43-02).
- Per-tag OG image generation is deferred to HUB-FUTURE-02; all tag pages share `${baseUrl}/api/og/hub` (43-02).
- List row uses `<article role="row">` with `::before` overlay (NOT a `<tr>` and NOT a wrapping `<a>`) to keep tile/row symmetry and preserve nested-button A11y for the vote cluster. The rowgroup wrapper is a `<div role="rowgroup">` with a scoped `biome-ignore lint/a11y/useSemanticElements` -- `<tbody>` cannot legally contain `<article>` (43-07).
- List-view zebra striping uses two new tokens: `--ds-row-stripe` (Layer 1 primitive, oklch-alpha 0.4) + `--color-row-stripe` (Layer 2 alias). Phase 43 is dark-only so no `.dark` override needed (43-07).
- Vote-state pattern is duplicated between `WorkflowTemplateGrid` and `WorkflowTemplateList`; refactor to a shared hook is a deliberate post-Phase-43 follow-up (43-07).
- Phase-44 marketplace-badge slot in the List row is reserved between price-per-call and the vote cluster but renders nothing in Phase 43 -- the comment marker in `workflow-template-row.tsx` is the insertion point.
- Anonymous + auto-anonymous Use-template flow uses an HttpOnly `pending_template` cookie (Path=/, SameSite=Lax, Max-Age=600) set by POST /api/auth/template-intent and atomically cleared by GET. PendingTemplateRunner mounts in app/layout.tsx (broadest scope — UI-SPEC §Open Issue #3 resolved) and triple-guards re-fire via useRef + sessionStorage TTL + server-side one-shot cookie (43-05).
- `.npmrc` extended to add all `@biomejs/cli-*` platform shim packages to `minimum-release-age-exclude` — `pnpm dlx`-driven biome resolution kept failing the 3-day-old gate even when @biomejs/biome itself was excluded. Fix landed via the 43-05 execution (commit 2395d087).
- Hub sidebar tag-link clicks wrapped in React 19 `useTransition` + `router.push(href, { scroll: false })`; `<Link>` preserved as the rendered element so cmd/ctrl/shift/alt/middle-click defer to the browser default for open-in-new-tab; `e.preventDefault()` only fires on plain left-click. The `<WorkflowSearchFilter>` mount was removed from `app/hub/_view-shell.tsx` (the component file remains but has zero consumers; deletion deferred to a future cleanup) — UAT gaps #3 + #4 closed (43-13).
- Dev-only back/forward hydration recovery `<Script>` lives at the root layout (`app/layout.tsx`, commit `06c1867f`), supersedes the per-page Phase-43 workaround on `app/hub/layout.tsx` (commit `cef214f0`, now deleted via commit `d4e61a36`). Detection contract `performance.getEntriesByType('navigation')[0]?.type === 'back_forward'` → `window.location.reload()`, JSX-gated on `process.env.NODE_ENV === "development"` for full production DCE. Companion artifacts: ADR `specs/architecture/back-forward-hydration.md` (commit `2df832d1`), unit test `tests/unit/root-layout-bfcache.test.ts` (commit `30a05ad0`), dual-mode Playwright suite `tests/e2e/playwright/back-forward-hydration.test.ts` + `playwright.config.ts` `NEXT_BUILD_MODE` switch + `pnpm test:e2e:bfcache:{dev,prod}` scripts (commits `554e7d93`, `84d1eb4f`, `69063092`). Cross-browser CI deferred per CONTEXT.md (Chromium-only by default; Firefox/WebKit opt-in via local invocation) (45-01..05).
- `/hub` is now a unified tabbed shell with three tabs in order Protocols / Workflows / Marketplace (Radix Tabs via the existing shadcn wrapper). URL contract is `?tab=protocols|workflows|marketplace`, updated via `router.replace(url, { scroll: false })`. Default tab when `?tab=` is absent is **Protocols** (overrides original HUBV2-01 "Workflows" default per Phase-44 CONTEXT.md user accept; REQUIREMENTS.md HUBV2-01 reworded). Page hero is "Hub" + "Browse protocols, fork community workflows, and discover paid services on the marketplace." (`components/hub/hub-hero.tsx`, mounted once at the page-shell level). Tab strip ships with a per-active-tab search slot (`HubTabSearch`); cross-tab unified search wiring is deferred. Single "Hub" left-nav entry (no secondary Marketplace link) per MARKET-11. Marketplace is a tab on `/hub` ONLY; the original standalone `/marketplace` route from the v1 plan was explicitly NOT created (ROADMAP success #8). Marketplace tab body is a server component (`app/hub/_marketplace-tab.tsx`) running a Drizzle GROUP-BY join over `workflows ⋈ workflow_payments`, wrapped in `unstable_cache(300s)`, with cursor pagination `LIMIT 50` on `(callCount DESC, workflowId)` tiebreaker. SELECT explicitly whitelists public columns; rendered HTML contains zero leaks of `creatorWalletAddress`, `userId`, `organizationId`, `payerAddress`, or precise `amountUsdc` (live-verified via real Chrome MCP). Sort dropdown shows two options only — Popular (default) and Newest; Earnings sort is EXPLICITLY ABSENT (deferred to v1.11.x or v1.12 per MARKET-FUTURE-01). MCP API extension: `GET /api/mcp/workflows?sort=popular|recent` and `search_workflows` MCP tool gain matching `sort` parameter; MCP tool count unchanged. The composite `(workflow_id, settled_at)` index on `workflow_payments` was reviewed via EXPLAIN ANALYZE and intentionally NOT added (existing `idx_workflow_payments_workflow` covers the GROUP-BY plan; revisit when MARKET-FUTURE-02 time-window leaderboards land). Phase-43 contracts (sidebar Sort+Tags, Cards/List toggle, hub_view cookie, Use-template CTA, pending_template OAuth round-trip, tag deep-link route) preserved INSIDE the Workflows tab; the inline Protocols strip and "Templates" header/divider that lived above the Phase-43 tile grid were deleted. No "Listed in marketplace" badge on Workflows-tab cards (HUBV2-08 / MARKET-10 SUPERSEDED); the marketplace-badge slot in `workflow-template-row.tsx` stays as a comment marker. Phase 44 commit anchor: `ce826a7a` (44-04 hero rewrite) → `86f0b6c7` (44-12 lint baseline clear ahead of UAT); 23 functional commits across 12 plans (44-01..44-12) plus the 44-12 lint-clean commit. UAT GREEN; 11/11 manual cases verified live in real Chrome via MCP at 1280x800; Phase-43 regression sweep PASS by construction (Workflows tab body lifted unchanged) + sampled live; observed `navType="reload"` on `history.back()` to `/hub?tab=marketplace` confirms the Phase-45 root-layout bfcache fix recovers hydration on tab-driven URL changes too; one non-blocking note documented (body-text "Earnings" hit traces to navigation-sidebar nav menu item, NOT the Marketplace sort dropdown — MARKET-02 contract holds); FF/Safari sweep deferred per same precedent as Phase 45 (44-12).

### Todos

- Run `/gsd-new-milestone` to start the next milestone cycle.

### Blockers

- None.

## Session Continuity

- Roadmap file: `.planning/ROADMAP.md`
- Requirements file: — (will be created by `/gsd-new-milestone`)
- Last shipped milestone: v1.11 (archived at `.planning/milestones/v1.11-{ROADMAP,REQUIREMENTS}.md`)
- Last completed: v1.11 milestone close finalization (2026-05-06)
- Stopped at: clean state — between milestones
- Next command: `/gsd-new-milestone` to define v1.12

## Deferred Items

Items acknowledged and deferred at v1.11 milestone close (2026-05-06) per `v1.11-MILESTONE-AUDIT.md` (status: `tech_debt`):

| Category | Item | Status |
|----------|------|--------|
| documentation | Phase 42 plan 42-10 manual UAT | deferred — primitives shipped, downstream Phase 43/44 verification provides implicit pass |
| documentation | Phase 43 VERIFICATION.md (retrospective) | deferred — phase shipped 2026-05-01 (UAT GREEN 15/15 per ROADMAP), 14 SUMMARY.md files exist |
| tracking | MODAL-01..08, SEC-01..06, NAV-01..08 unticked in archive | deferred — see closure note in `milestones/v1.11-REQUIREMENTS.md` |
| tracking | HUB-07, HUB-15, HUB-18..22 unticked in archive | deferred — Phase 43 shipped, REQ-IDs not retroactively ticked |
| lint | Repo-wide Biome baseline drift to ~263 errors | pre-existing; Phase 44+45 introduced zero new errors. Recommend dedicated lint-cleanup phase before next major PRs |
| feature | MARKET-FUTURE-01..04 | deferred — see `milestones/v1.11-REQUIREMENTS.md` § Future Requirements |
| feature | HUB-FUTURE-02 (per-tag OG image generation) | deferred |
| testing | Cross-browser CI runs (Firefox + WebKit) | deferred — Chromium-only by default; opt-in via local invocation |
| upstream | Next.js bfcache hydration race upstream issue/PR | deferred per Phase 45 ADR |
