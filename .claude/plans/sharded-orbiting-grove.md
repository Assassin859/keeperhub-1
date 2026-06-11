# KEEP-671 — Google-Docs-style history & activity UI

## Context

The audit/versioning backend is built and merged up to staging (security_audit_log, workflow_history, execution attribution, read APIs, migrations 0107-0109). The current UI is a centered **modal** with a cramped left list + raw-ish right pane — it reads as ugly. We're redesigning the history/activity surfaces to match **Google Docs version history**: a right-docked panel, a date-grouped timeline with author avatars and relative time, a "Current" marker, the selected version previewed **live on the canvas**, inline change detail, and Restore at the top. The same visual language is applied to the API-key activity and a new org-wide Activity view.

Scope (confirmed): **all three surfaces** — workflow version history (primary), API-key activity, and a dedicated org Activity view. Admin/owner only (existing gate). No backend changes — endpoints exist: `GET /api/workflows/[id]/history`, `GET /api/workflows/[id]?version=N`, `GET /api/security/audit` (actor-enriched).

Reuse (do not reinvent): `relativeTime` ([components/settings/session-format.ts](components/settings/session-format.ts)), `computeVersionDiff` ([lib/workflow/version-diff.ts](lib/workflow/version-diff.ts)), `previewVersionAtom` + the preview banner ([components/workflow/version-preview-banner.tsx](components/workflow/version-preview-banner.tsx)), `useActiveMember`/`isOrgAdmin`, `api.workflow.getHistory/getById` + `api.security.getAudit` ([lib/api-client.ts](lib/api-client.ts)), and UI primitives `Avatar`, `Badge`, `Separator`, `Tooltip`, `Skeleton`, `Button` from `components/ui/*`. Tokens only (`bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `text-keeperhub-green`, radius/space/z); run `node scripts/token-audit.js` before commit.

---

## Part 1 — Shared history/activity building blocks

- **`lib/activity/time-groups.ts`** (new, pure + unit-tested): `groupByDate(items, getISO)` → ordered `[{ label: "Today"|"Yesterday"|"This week"|"Earlier"|<month yyyy>, items }]`. Native `Date` only (no date-fns).
- **`lib/security/audit-actions.ts`** (new, pure + unit-tested): `describeAuditAction(event)` → `{ phrase, kind }` where `phrase` is human ("created an API key", "changed the plan", "rotated a wallet signing key", …) and `kind` is `add | remove | change` for icon/color. Covers every `action` we emit; falls back to a humanized dotted-name.
- **`components/activity/actor-avatar.tsx`** (new): `Avatar` + initials fallback from name/email, optional image, size prop, name tooltip. Mirrors [members-list.tsx](components/organization/members-list.tsx) display.
- **`components/activity/activity-feed.tsx`** (new): the shared Google-Docs-activity list for **audit events**. Props: a fetcher result (events + `nextCursor`) or a `params` object it fetches via `api.security.getAudit`. Renders date-group headers (muted, sticky) + rows (`ActorAvatar` · `{actor} {phrase}` · kind icon `Plus/Minus/Pencil` in green/red/amber · `relativeTime`), an expandable row revealing metadata (ip/country/UA) and, when present, the deep-diff as a compact list. "Load more" via `nextCursor`. `thin-scrollbar`. Loading = `Skeleton` rows; empty + error states.

---

## Part 2 — Workflow version history → right-docked live panel

Replace the modal ([components/overlays/workflow-version-history-overlay.tsx](components/overlays/workflow-version-history-overlay.tsx)) with a **non-modal right-docked panel** so the canvas stays visible for live preview (a modal Sheet's backdrop would hide it).

- **`components/workflow/version-history-panel.tsx`** (new): fixed right-docked panel (`top: var(--header-height)`, `right-0`, `~w-[360px]`, full height, `border-l bg-card shadow`, z below modals/toasts). Controlled by a new `versionHistoryOpenAtom` in [lib/workflow/store.ts](lib/workflow/store.ts). Contents:
  - Header: "Version history" + Restore button (enabled when a non-current version is selected) + close.
  - Date-grouped timeline (`groupByDate` + `ActorAvatar` + `relativeTime` + "Current" badge on latest).
  - **Click a version = live preview**: set `previewVersionAtom` and load that snapshot into the canvas (reuse the existing view-on-canvas path); selected row highlighted; the existing preview banner already shows "Viewing version N". Closing the panel exits preview (reloads live).
  - **Inline change detail**: the selected entry expands to its `computeVersionDiff` semantic list (added/removed/changed nodes with type + before→after via icons, connections) — the readable list we already build, rendered with `Plus/Minus/Pencil` icons (no glyph arrows; `ArrowRight` icon where needed).
- **Toolbar**: the existing `VersionHistoryButton` ([workflow-toolbar.tsx](components/workflow/workflow-toolbar.tsx)) toggles `versionHistoryOpenAtom` instead of opening the overlay; mount `<VersionHistoryPanel/>` in the editor (persistent toolbar area, next to the preview banner). Admin/owner gate unchanged.
- Delete the old overlay file once the panel replaces it.

---

## Part 3 — API-key activity restyle

In [components/overlays/api-keys-overlay.tsx](components/overlays/api-keys-overlay.tsx), replace the bespoke `OrgApiKeyActivity` list with `<ActivityFeed params={{ resourceType: "org_api_key" }} />` so it uses the shared Google-Docs visual (avatars, grouped, icons). Keep the existing "View key activity" disclosure/CTA.

---

## Part 4 — Org-wide Activity view (admin/owner)

In [components/overlays/settings-overlay.tsx](components/overlays/settings-overlay.tsx), add an **"Activity"** tab (rendered only when `useActiveMember().isAdmin`) containing `<ActivityFeed />` with no `resourceId` (all org events), paginated via `nextCursor`. This is the dedicated org audit trail, same styling.

---

## Verification

- **Unit**: `groupByDate` (Today/Yesterday/week/earlier boundaries) and `describeAuditAction` (every emitted action maps to a phrase + correct kind; unknown → humanized fallback).
- **Tokens/lint/types**: `node scripts/token-audit.js` (zero errors), `pnpm check`, `pnpm type-check` — all clean on changed files.
- **Manual (`pnpm dev:login`, owner)**: open a workflow → History button opens the right panel; canvas stays visible; clicking a version previews it live (banner shows); selected entry expands to a readable change list; Restore brings it back. Open Settings → Activity tab → grouped feed of recent sensitive actions with avatars; create/revoke an API key and see it appear. API-keys overlay activity shows the same styling. Confirm a non-admin member sees neither the panel control nor the Activity tab.

## Notes / out of scope
- No backend/schema/migration changes.
- Still deferred (separate): org limits, failed/blocked-attempt logging, retention/pruning, the autosave-vs-validation decoupling.
