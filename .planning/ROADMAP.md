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

---

## Current Milestone: v1.10 Agentic Wallet & Marketplace Plumbing

**Goal:** Close two gaps blocking agent-to-marketplace flows: fix the broken x402 signing path in `@keeperhub/wallet`, give agents per-call protocol selection (x402 vs MPP), and expose the full curator lifecycle for workflow listings via MCP so agents can manage their marketplace presence without UI clicks.

## Phases

- [ ] **Phase 40: Agentic Wallet — x402 Fix + Payment Hint** - Diagnose and fix `verification-failed` for fresh sub-orgs; add `paymentHint` override to `signer.fetch`/`pay`; one npm version bump, one PR (agentic-wallet repo)
- [ ] **Phase 41: Marketplace MCP Curator Tools** - Add four MCP curator tools (`list_workflow`, `unlist_workflow`, `update_workflow_listing`, `get_workflow_listing`) backed by new listing routes; one PR to staging (keeperhub repo)

---

## Phase Details

### Phase 40: Agentic Wallet — x402 Fix + Payment Hint
**Goal**: Any provisioned agentic-wallet sub-org can complete an x402 payment end-to-end, and agents can select x402 or MPP per call with a typed `paymentHint` field
**Depends on**: Nothing (first phase of v1.10; Phase 41 can run concurrently — no code dependency)
**Requirements**: WX402-01, WX402-02, WX402-03, WX402-04, WX402-05, WX402-06, WHINT-01, WHINT-02, WHINT-03, WHINT-04, WHINT-05, WHINT-06, TEST-01 (Phase A portion)
**Success Criteria** (what must be TRUE):
  1. A fresh agentic-wallet sub-org provisioned same-day, never previously used for x402, completes `paymentSigner.fetch(...)` against a KeeperHub x402-gated workflow and receives 200 — not a 402 with `verification-failed`
  2. An agent calling `signer.fetch(url, { paymentHint: "mpp" })` on a resource that offers only MPP pays via MPP; calling with `paymentHint: "x402"` on a resource that offers only x402 pays via x402; requesting a protocol not in the 402 challenge throws a typed `KeeperHubError` with the appropriate code (`X402_NOT_OFFERED` or `MPP_NOT_OFFERED`)
  3. All 9 cases in the hint x challenge-availability matrix (3 hints: auto/x402/mpp, times 3 availability states: x402-only/mpp-only/both) pass unit tests and produce no regressions on the `auto` (default) path
  4. Seven named test files pass with no skips: `payment-signer-x402-payload.test.ts`, `sign-x402-challenge.test.ts`, `x402-domain-version.test.ts`, `mpp-attribution-memo.test.ts`, `payment-signer-hint.test.ts`, `payment-hint.test.ts`, `x402-repro.test.ts`
  5. Work is fully verified on local dev server (pnpm dev + pnpm link or npm pack) before the PR is opened; trace logging added during diagnostics is removed before merge
**Plans**: 4 plans
Plans:
- [ ] 40-01-PLAN.md — 4-step EIP-712 diagnostic: log grep, trace patch, x402-repro.test.ts harness, fresh-wallet CDP smoke test
- [ ] 40-02-PLAN.md — KEEP-364 fix (conditional on confirmed suspect) + four named regression-guard tests (WX402-03..06)
- [ ] 40-03-PLAN.md — KEEP-361 paymentHint: PaymentHint type, FetchInit, selectProtocol pure function, 9-case test matrix
- [ ] 40-04-PLAN.md — Trace logging removal, npm version bump to 0.2.0, build, local link, end-to-end smoke test, hand-off summary

### Phase 41: Marketplace MCP Curator Tools
**Goal**: Agents can list, unlist, update, and inspect workflow listings programmatically via MCP without any UI interaction
**Depends on**: Phase 40 is a logical predecessor (x402 fix unblocks paid testing of listed workflows) but there is no code dependency — Phase 41 can be coded concurrently in the keeperhub repo
**Requirements**: MLIST-01, MLIST-02, MLIST-03, MLIST-04, MLIST-05, MLIST-06, MLIST-07, MLIST-08, MLIST-09, MLIST-10, TEST-01 (Phase B portion)
**Success Criteria** (what must be TRUE):
  1. An MCP agent can call `list_workflow(workflowId, metadata)` and the workflow immediately appears in the public `GET /api/mcp/workflows` catalog with `isListed=true` and an assigned `listedSlug` — no UI clicks required
  2. An MCP agent can call `unlist_workflow(workflowId)` and the workflow is removed from the catalog (`isListed=false`), then call `list_workflow` again and the original `listedSlug` is preserved and `listedAt` is refreshed — confirmed by the list/unlist/relist integration test
  3. Calling `update_workflow_listing` to change `priceUsdcPerCall` while the workflow is listed returns 409 `PRICE_CHANGE_WHILE_LISTED`; a slug collision returns 409 `SLUG_CONFLICT`; accessing another org's workflow ID returns 404
  4. `get_workflow_listing(slug)` is publicly accessible, IP-rate-limited, and returns `Cache-Control: public, max-age=60` — no auth required for reads
  5. Four named test files pass with no skips: `mcp-curator-tools.test.ts`, `workflow-listing-lifecycle.test.ts`, `mcp-curator-slug.test.ts`, `mcp-curator-price-change.test.ts`
**Plans**: TBD
**UI hint**: yes

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 40. Agentic Wallet — x402 Fix + Payment Hint | 0/4 | Planned | - |
| 41. Marketplace MCP Curator Tools | 0/? | Not started | - |
