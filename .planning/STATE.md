---
gsd_state_version: 1.0
milestone: v1.11
milestone_name: Marketplace Discovery & Hub UX
status: executing
last_updated: "2026-05-01T02:01:06.790Z"
last_activity: 2026-05-01
progress:
  total_phases: 4
  completed_phases: 2
  total_plans: 30
  completed_plans: 29
  percent: 97
---

# Project State

## Project Reference

- **Core value:** Users can build and deploy Web3 automation workflows through a visual builder without writing code.
- **Current focus:** Phase 45 — Back/Forward Hydration Fix

## Current Position

Phase: 45 (Back/Forward Hydration Fix) — EXECUTING
Plan: 1 of 6

- **Phase:** 42 — Foundations & Shared Primitives (next; not started)
- **Plan:** —
- **Status:** Executing Phase 45
- **Last activity:** 2026-05-01

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
- Requirements mapped: 60/60 (excluding TEST-01..03 which are cross-cutting on every phase)
- Requirements completed: HUB-01, HUB-02, HUB-03, HUB-04, HUB-05, HUB-06, HUB-07, HUB-08, HUB-09, HUB-10, HUB-11, HUB-12, HUB-13, HUB-14, HUB-15, HUB-16, HUB-17, HUB-18, HUB-19, HUB-20, HUB-21, HUB-22, HUB-23, HUB-24, HUB-25, TEST-02 (26/60)

## Accumulated Context

### Decisions (already locked, do NOT re-debate during planning)

- Marketplace lives at new top-level `/marketplace` route (NOT a Hub tab)
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

### Todos

- /gsd-plan-phase 42 — Foundations & Shared Primitives
- /gsd-plan-phase 43 — Hub UX Overhaul (apply `/frontend-design:frontend-design`)
- /gsd-plan-phase 44 — Marketplace Ladder (apply `/frontend-design:frontend-design`)

### Blockers

- None.

## Session Continuity

- Roadmap file: `.planning/ROADMAP.md`
- Requirements file: `.planning/REQUIREMENTS.md`
- Research summary: `.planning/research/SUMMARY.md`
- Last completed: Plan 43-13 (gap-closure — UAT gaps #3 + #4 closed; `<WorkflowSearchFilter>` mount and import removed from `app/hub/_view-shell.tsx`; orphan `handleToggleTag` deleted; sidebar tag-link clicks wrapped in `useTransition` + `router.push` with `scroll: false`; modifier-click semantics preserved via early-return gate; HUB-23, HUB-24)
- Stopped at: 43-13 complete (commits 6f54113a + b68027c5)
- Next command: see orchestrator chain
