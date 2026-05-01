# Roadmap: KeeperHub

## Milestones

- Complete **v1.0 Service Extraction** - Phases 1-4 (shipped 2026-02-12)
- Complete **v1.1 OG Image Generation** - Phase 5 (shipped 2026-02-12)
- Complete **v1.2 Protocol Registry** - Phases 6-9 (shipped 2026-02-20)
- Complete **v1.3 Direct Execution API** - Phases 10-12 (shipped 2026-02-20)
- Complete **v1.4 Agent Team** - Phases 13-18 (shipped 2026-03-01)
- Complete **v1.5 KeeperHub CLI** - Phases 19-24 (shipped 2026-03-14)
- Complete **v1.7 Agent-Callable Workflows** - Phases 25-31 (shipped 2026-04-21)
- Complete **v1.8 Agentic Wallet for KeeperHub** - Phases 32-36 (shipped 2026-04-21) — archived in [milestones/v1.8-ROADMAP.md](milestones/v1.8-ROADMAP.md)
- Complete **v1.9 Code Sandbox Hardening (Minimal)** - Phases 37-39 (shipped 2026-04-23) — archived in [milestones/v1.9-ROADMAP.md](milestones/v1.9-ROADMAP.md)
- Complete **v1.10 Agentic Wallet & Marketplace Plumbing** - Phases 40-41 (shipped 2026-04-29) — archived in [milestones/v1.10-ROADMAP.md](milestones/v1.10-ROADMAP.md)
- Complete **v1.11 Marketplace Discovery & Hub UX** - Phases 42-45 (shipped 2026-05-01) — archived in [milestones/v1.11-ROADMAP.md](milestones/v1.11-ROADMAP.md)

---

## Current Milestone: TBD (v1.12 — run `/gsd-new-milestone` to define)

(Previous v1.11 milestone archived above. Run `/gsd-new-milestone` to start the next milestone with fresh requirements.)

---

<!-- Archived v1.11 phase details preserved below for reference; will be removed when v1.12 starts. -->

## Archived: v1.11 Marketplace Discovery & Hub UX

**Goal:** Make listed workflows discoverable across the platform, modernize Hub UX so logged-out users can browse, consolidate workflow import/export into one modal, and let template adoption flow through a clear login-gated CTA.

**Linear issues:** KEEP-303, KEEP-326, KEEP-297, KEEP-368

## Phases

- [x] **Phase 42: Foundations & Shared Primitives** - Single Import/Export modal, shared SignInPromptOverlay, logged-out left-nav, hardened import schema (KEEP-368 + KEEP-297) — 9/10 plans complete; VERIFICATION.md `status: human_needed` pending the 42-10 manual UAT gate
- [x] **Phase 43: Hub UX Overhaul** - Green Use-template CTA + login gate, deep-link tag URLs, fully-clickable tile, Cards/List toggle, sidebar reorg with Tags + Sort (KEEP-326) — UAT complete 2026-05-01, 15/15 passed
- [x] **Phase 44: Unified Tabbed Hub (Protocols / Workflows / Marketplace)** - `/hub` is now a tabbed shell (Protocols default / Workflows / Marketplace) with `?tab=` URL contract (KEEP-303). Hero rewritten to "Hub". Marketplace tab is the popularity-sorted leaderboard (server component + `unstable_cache(300s)` + cursor pagination + privacy-whitelisted SELECT). MCP API extended with `?sort=popular|recent`; `search_workflows` MCP tool gains matching `sort` param. Composite DB index reviewed and intentionally not added (existing index covers GROUP-BY). UAT GREEN; live cross-browser sweep verified in Chrome via MCP (FF/Safari deferred per user accept). 24 commits across 12 plans.
- [x] **Phase 45: Back/Forward Hydration Fix** - Root-layout dev-only `<Script>` (`app/layout.tsx`, commit `06c1867f`) supersedes the per-page workaround. Per-page Phase-43 Script deleted from `app/hub/layout.tsx`. Dual-mode Playwright suite + ADR + replacement unit test landed. UAT GREEN; cross-browser sweep verified live in Chrome (FF/Safari deferred per user accept).

---

## Phase Details

### Phase 42: Foundations & Shared Primitives
**Goal**: Ship the shared primitives the rest of v1.11 depends on — one unified Import/Export modal, one shared SignInPromptOverlay, a logged-out-friendly left-nav, and a hardened import schema — with zero 401 spam, zero hydration warnings, and no surface for arbitrary-payload abuse.
**Depends on**: Nothing (first phase of v1.11)
**Requirements**: MODAL-01, MODAL-02, MODAL-03, MODAL-04, MODAL-05, MODAL-06, MODAL-07, MODAL-08, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, NAV-01, NAV-02, NAV-03, NAV-04, NAV-05, NAV-06, NAV-07, NAV-08, TEST-01, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):
  1. The Download button in `workflow-toolbar.tsx` and the (now-removed) sidebar Import button both resolve into one `WorkflowIOOverlay` with shadcn Tabs — old `import-workflow-overlay.tsx` and `export-workflow-overlay.tsx` files are deleted, not deprecated, and switching tabs mid-flight does not crash or leak file state.
  2. An anonymous, signed-out, or auto-provisioned-anonymous user loads `/` and sees every left-nav item; clicking any `requireAuth` item opens the shared `SignInPromptOverlay` (with optional `intent` payload) — never a 401-bouncing page, never an org-switcher, and the network log records zero 401 responses on initial load.
  3. The page renders without React 19 hydration warnings: the sidebar branches on `useSession().isPending` first (neutral skeleton), and `usePersistedNavState` discards stale snapshots via a `version` field so removing the sidebar Import button never crashes returning users.
  4. A 100 MB JSON upload, an oversized description, a `.passthrough()` payload, a 201-node workflow, and a non-https webhook URL are all rejected by `lib/workflow/export-schema.ts` (now `.strict()` + `.max()` caps) and by the server route via `Content-Length` pre-check (HTTP 413). Imported workflows containing `code` step nodes with non-empty user code are gated by an explicit confirmation step.
  5. Local UAT gate passed before PR is opened: `pnpm dev` smoke run, `pnpm discover --auth` golden paths captured, manual viewport check at 1280x800 minimum, and `pnpm check` + `pnpm type-check` + `node scripts/token-audit.js` all green with zero errors.
  6. Three named Playwright/Vitest tests pass with no skips: `tests/e2e/playwright/workflow-io-modal.test.ts` (MODAL-08), `tests/e2e/playwright/logged-out-nav.test.ts` (NAV-08), `tests/unit/workflow-import-schema.test.ts` (SEC-06).
**Plans:** 10 plans
- [ ] 42-01-PLAN.md — Wave 0 test scaffolding & fixtures
- [ ] 42-02-PLAN.md — Import schema hardening (.strict() + .max() + https-only webhook + findCodeStepsWithContent helper)
- [ ] 42-03-PLAN.md — Import endpoint Content-Length 413 guard
- [ ] 42-04-PLAN.md — usePersistedNavState versioning (VERSION = 2)
- [ ] 42-05-PLAN.md — AuthDialog controlled-mode refactor + AuthPromptProvider + useAuthPrompt hook
- [ ] 42-06-PLAN.md — Sidebar logged-out support (requireAuth flags, isPending skeleton, gated fetchData, OrgSwitcher gate, delete sidebar Import button)
- [ ] 42-07-PLAN.md — Unified WorkflowIOOverlay (single Dialog, no tabs, SEC-01/SEC-05 gates)
- [ ] 42-08-PLAN.md — Toolbar wiring + delete old import/export overlay files
- [ ] 42-09-PLAN.md — Test implementations (workflow-io-modal, logged-out-nav, workflow-import-schema)
- [ ] 42-10-PLAN.md — Local UAT gate + human-verify checkpoint
**UI hint**: yes

### Phase 43: Hub UX Overhaul
**Goal**: Modernize the Hub so anyone — logged-in, signed-out, or auto-provisioned-anonymous — can browse, deep-link to a single tag, toggle Cards/List view, and adopt a template through a clear green CTA without falling into a 403 or an OAuth redirect loop.
**Depends on**: Phase 42 (consumes the shared `SignInPromptOverlay`, the `usePersistedNavState` `version` field, and the logged-out-nav `requireAuth` plumbing)
**Requirements**: HUB-01, HUB-02, HUB-03, HUB-04, HUB-05, HUB-06, HUB-07, HUB-08, HUB-09, HUB-10, HUB-11, HUB-12, HUB-13, HUB-14, HUB-15, HUB-16, HUB-17, HUB-18, HUB-19, HUB-20, HUB-21, HUB-22, HUB-23, HUB-24, HUB-25, TEST-01, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):
  1. Every Hub template tile shows a persistent green "Use template" CTA (using `--ds-green-accent` / `--color-text-accent` tokens, no hardcoded hex) and the entire tile body is clickable into Preview via a CSS pseudo-element overlay — vote and CTA buttons remain independently focusable and accessible.
  2. An anonymous or auto-provisioned-anonymous user clicks "Use template", completes Google OAuth or magic-link, and the duplicate fires exactly once with no intermediate dialog reopen and no infinite redirect loop. Intent survives the round-trip via the `pending_template` HttpOnly `SameSite=Lax` cookie (NOT localStorage); post-OAuth landing does a hard `router.refresh()` before reading session; auto-trigger is wrapped in a 30s sessionStorage idempotency key.
  3. Visiting `/hub/tags/[tag]` for any seeded public tag renders a tag-filtered Hub, returns a tag-specific `<title>` / description / OG image / `<link rel="canonical">` via `generateMetadata`, pre-renders at build via `generateStaticParams`, and is enumerated in `app/sitemap.ts`. `app/robots.ts` disallows `/hub?*` and `/marketplace?*` query-string variants. Reserved slugs (`tags`, `protocol`, `marketplace`, `auth`, `api`, `admin`, `_next`, `og`, `well-known`) cannot be used for either workflow listings or public tags.
  4. The Hub shows a Cards / List toggle backed by Radix `ToggleGroup type="single"`; preference persists in the `hub_view` cookie (`Path=/`, `SameSite=Lax`, 1 year), is read via `cookies()` in the RSC, and a page reload after toggling produces zero hydration mismatch and the same view on first paint. Toggle preserves scroll position via `useLayoutEffect`.
  5. Sort and Tags controls are moved out of the page header into the left sidebar; sidebar tags are clickable links to `/hub/tags/[tag]`; `usePersistedNavState` snapshot version is bumped so v1.10 layouts referencing the old panels are invalidated cleanly.
  6. Local UAT gate passed before PR is opened: `pnpm dev` smoke (logged-in + signed-out + auto-anon), `pnpm discover /hub --auth --highlight` and `pnpm discover /hub/tags/<seeded-tag>` reports captured, manual viewport check at 1280x800 minimum, `pnpm check` + `pnpm type-check` + `node scripts/token-audit.js` all green, and the planning agent applied the `/frontend-design:frontend-design` skill before writing plans.
**Plans**: TBD
**UI hint**: yes

### Phase 45: Back/Forward Hydration Fix
**Goal**: Replace the dev-only force-reload workaround on `/hub` (`app/hub/layout.tsx`, committed in Phase 43 as commit `cef214f0`) with a real fix that lets every page recover from a browser back/forward navigation without losing client hydration. Either land the fix in Next.js itself, or apply a framework-agnostic workaround at root layout that does not break legitimate user flows depending on persisted page state.
**Depends on**: Nothing — orthogonal cleanup. Should land before any phase that adds heavy client-side state to pages users routinely back-button into.
**Requirements** (to be expanded into a SPEC during /gsd-plan-phase):
  - Reproduce on a clean `pnpm dev` instance: navigate to any client-component-heavy page (`/hub`, `/billing`), navigate away, navigate back, observe the React tree fail to hydrate (DOM has no `__reactContainer*` markers, `__next_f` flight buffer empty, zero interactive elements).
  - Determine root cause: streaming RSC payload, Router cache restoration, App Router init order, HMR WebSocket race, or interaction between them. Compare against `pnpm build && pnpm start` to confirm prod is unaffected (or, if it's not, escalate scope accordingly).
  - Land the fix at root layout (or upstream) so all pages benefit, not just `/hub`.
  - Remove the dev-only Script in `app/hub/layout.tsx` once the upstream fix is in place.
  - Verify in Chrome (Cmd+Shift+T tab restore), Firefox (Cmd+Shift+T), and Safari (back gesture) that the same flow no longer regresses.
**Success Criteria** (what must be TRUE):
  1. After back/forward navigation to any page, `document.querySelectorAll('button').length` matches what a direct nav to the same page produces, and `document.querySelectorAll('[__reactContainer]')` (or the React 19 equivalent) is non-empty.
  2. The dev-only `<Script>` in `app/hub/layout.tsx` is deleted; no other page-level workarounds remain.
  3. A Playwright test (`tests/e2e/playwright/back-forward-hydration.test.ts`) navigates `/hub → /billing → goBack`, asserts the rehydrated page renders the expected sidebar nav buttons and template tiles, and asserts `performance.getEntriesByType('navigation')[0]?.type !== 'reload'` (proving we are not relying on a forced reload to recover).
  4. The same test runs against `pnpm dev` and `pnpm start` builds.
  5. Local UAT gate passed before PR is opened: `pnpm check` + `pnpm type-check` green, `pnpm test:e2e --grep "back-forward"` green.
**Plans:** 6 plans
- [ ] 45-01-PLAN.md — Add dev-only bfcache reload Script to root layout (BFCACHE-01)
- [ ] 45-02-PLAN.md — Strip per-page bfcache workaround from app/hub/layout.tsx (BFCACHE-02)
- [ ] 45-03-PLAN.md — Write back-forward hydration ADR under specs/architecture/ (BFCACHE-06)
- [ ] 45-04-PLAN.md — Replace hub-layout-bfcache.test.ts with root-layout-bfcache.test.ts (BFCACHE-03)
- [ ] 45-05-PLAN.md — Dual-mode Playwright e2e test + NEXT_BUILD_MODE config + npm scripts (BFCACHE-04, BFCACHE-05)
- [ ] 45-06-PLAN.md — Local UAT gate + cross-browser sweep + STATE.md/ADR commit-ref backfill (BFCACHE-07)
**UI hint**: no

### Phase 44: Unified Tabbed Hub (Protocols / Workflows / Marketplace)
**Goal**: Replace the current `/hub` layout with a unified, tabbed discovery surface that consolidates Protocols, Workflows, and Marketplace under one route. Tab navigation is the ClawHub Skills/Plugins pattern: instant tab switch with no flicker, URL updates per tab so deep links and browser history work. Drop the standalone Protocols strip and the "Templates" header/divider that exist today; Protocols become full cards inside their own tab. Rename the page hero away from "Web3 Workflow Templates" to copy that reflects all three surfaces. Marketplace tab is the popularity-sorted leaderboard, surfaced consistently to humans (UI tab) and agents (`/api/mcp/workflows?sort=` + `search_workflows`) — without leaking any per-creator USDC figure or wallet address.
**Depends on**: Phase 42 (consumes the shared `SignInPromptOverlay` and logged-out-nav primitives — Marketplace tab is visible to all users and gates on click). Phase 43 (consumes the rebuilt Hub view shell, sidebar, view-toggle, and tile/row components; the Workflows tab is the existing `/hub` content moved into a tab). Phase 45 (back/forward hydration fix) is recommended so tab-driven URL changes don't trip the same Next.js 16 dev hydration race.
**Requirements**: HUBV2-01, HUBV2-02, HUBV2-03, HUBV2-04, HUBV2-05, HUBV2-06, HUBV2-07, HUBV2-08, MARKET-01, MARKET-02, MARKET-03, MARKET-04, MARKET-05, MARKET-06, MARKET-07, MARKET-08, MARKET-09, MARKET-10, MARKET-11, MARKET-12, MARKET-13, TEST-01, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):
  1. `/hub` renders a tabbed shell with three tabs in this order: **Protocols**, **Workflows**, **Marketplace**. Tab style follows the ClawHub Skills/Plugins pattern: pill-shaped active tab with icon, semi-transparent inactive tabs, and a search bar visible alongside the tab strip. The default active tab is Workflows (preserves existing `/hub` semantics). Tab switching is instant (no Suspense fallback flash, no skeleton flicker) and updates the URL in place via `history.replaceState` or `router.replace` — deep linking works (`/hub?tab=protocols`, `/hub?tab=marketplace`, `/hub?tab=workflows`), and the browser back button steps tab-by-tab. The exact URL convention (query param vs subroute) is decided during /gsd-spec-phase 44.
  2. The Protocols tab renders each protocol as a full card (image + name + tagline + workflow count) in a responsive grid — replacing today's compact horizontal Protocols strip on the Workflows tab. Clicking a protocol card opens the existing protocol detail modal (no behavior regression). The standalone "Protocols" header and the "Templates" header/divider that today separate the protocol strip from the tile grid are removed; each tab owns its own content area without inter-tab dividers.
  3. The Workflows tab is the existing `/hub` workflow discovery surface (sidebar Sort + Tags, Cards/List view toggle, tile grid + list view) lifted intact into a tab. The hero copy on the page is renamed away from "Web3 Workflow Templates / On-chain monitoring, DeFi strategies, and security alerts. Fork any template to your organisation in one click." to copy that reflects all three surfaces (Protocols + Workflows + Marketplace) — final wording decided during /gsd-spec-phase 44.
  4. The Marketplace tab renders a popularity-sorted leaderboard of `isListed=true` workflows (call count from `workflow_payments`, descending) by default, with sort options Newest (`listedAt` desc) and Top calls (`COUNT(workflow_payments)` desc) — earnings sort is explicitly absent (deferred to v1.11.x). Each row shows rank, display name, top-3 public tags, total call count, price-per-call, chain badge (Base/Tempo), and a Use-this-workflow CTA.
  5. A grep of the rendered HTML and any JSON response from the Marketplace tab surfaces zero occurrences of `creatorWalletAddress`, `userId`, `organizationId`, `payerAddress`, or precise `amountUsdc` — the Drizzle SELECT explicitly whitelists public columns only. Verified by the MARKET-13 Playwright test asserting no leaked sensitive columns.
  6. The Marketplace aggregate query is a direct Drizzle GROUP-BY join over `workflows ⋈ workflow_payments`, wrapped in `unstable_cache` (5-10 minute TTL) with `revalidate: 60`; response carries `Cache-Control: s-maxage=300, stale-while-revalidate=60`; pagination is `LIMIT 50` + cursor; the `(workflow_id, settled_at)` composite index on `workflow_payments` is reviewed and added (with a Drizzle migration committed in this phase) if missing.
  7. `GET /api/mcp/workflows?sort=popular|recent` returns the same sorted catalog as the Marketplace tab; the existing `search_workflows` MCP tool gains a `sort` parameter with the same enum and defaults to popularity ranking. Total registered MCP tool count is unchanged — no new tools added.
  8. The standalone `/marketplace` route from the original Phase 44 plan is NOT created; marketplace is a `/hub` tab only. The standalone Marketplace nav entry in the left sidebar planned in v1 is replaced by relying on the Hub nav entry to land on `/hub` — final nav decision (single Hub entry vs Hub-with-default-tab + secondary tab links) decided during /gsd-spec-phase 44. No "Listed in marketplace" badge or marketplace-related decoration on Workflows tab cards or rows; cross-tab discovery happens via the tab strip only.
  9. Tab switches do NOT cause a full route re-mount (no skeleton flicker on the surrounding shell). The shared sidebar Sort+Tags and Cards/List toggle are scoped to the tab they belong to (Workflows) and either hide or swap when other tabs are active. Tab switching round-trip latency is dominated by data fetch only — no Next.js Router cache miss / RSC re-render of the tab shell.
  10. Local UAT gate passed before PR is opened: `pnpm dev` smoke against seeded `workflow_payments` data, `pnpm discover /hub --auth --highlight` reports captured for each tab, sort dropdown manually exercised across all three options on the Marketplace tab, manual viewport check at 1280x800 minimum, `pnpm check` + `pnpm type-check` + `node scripts/token-audit.js` all green, the planning agent applied the `/frontend-design:frontend-design` skill before writing plans, and the existing Phase 43 UAT (43-UAT.md) re-passes — every Phase 43 success criterion still holds inside the new Workflows tab.
**Plans:** 2/12 plans executed
- [ ] 44-01-PLAN.md — Tab shell scaffolding (HubTabsShell + page.tsx host; default = Protocols)
- [ ] 44-02-PLAN.md — Workflows tab lift + delete Protocols strip + Templates divider + plant marketplace-badge slot marker
- [ ] 44-03-PLAN.md — Protocols tab content (HubProtocolsTab + ProtocolCardV2 + detail island)
- [x] 44-04-PLAN.md — HubHero rewrite ("Hub" + locked sub copy)
- [ ] 44-05-PLAN.md — Marketplace tab content (cached Drizzle leaderboard + MarketplaceRow + privacy whitelist)
- [ ] 44-06-PLAN.md — Marketplace sort dropdown (Popular default, Newest; earnings absent)
- [ ] 44-07-PLAN.md — MCP API + tool extension (?sort=popular|recent + search_workflows sort param)
- [ ] 44-08-PLAN.md — Drizzle migration evaluation for workflow_payments composite index (gated on EXPLAIN)
- [ ] 44-09-PLAN.md — Per-tab generateMetadata + tab-strip search slot + HubHero mount
- [x] 44-10-PLAN.md — Sidebar audit (single Hub entry, no Marketplace addition)
- [ ] 44-11-PLAN.md — Playwright e2e (tabbed-hub-shell + marketplace-tab tests)
- [ ] 44-12-PLAN.md — Local UAT gate + REQUIREMENTS.md HUBV2-01 wording correction
**UI hint**: yes

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 42. Foundations & Shared Primitives | 9/10 | Verification: human_needed | - |
| 43. Hub UX Overhaul | 14/14 | UAT complete | 2026-05-01 |
| 44. Unified Tabbed Hub | 2/12 | In Progress|  |
| 45. Back/Forward Hydration Fix | 0/? | Not started | - |
