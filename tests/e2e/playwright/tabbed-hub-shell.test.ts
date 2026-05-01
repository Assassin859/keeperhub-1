import { expect, test } from "@playwright/test";

// Phase 44 tabbed Hub shell uses anonymous storage state — these tests must
// pass for logged-out visitors too (the Hub is publicly browseable).
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Tabbed Hub shell (HUBV2-02 / HUBV2-03 / HUBV2-08)", () => {
  test.beforeEach(async ({ context }) => {
    // Belt-and-braces: even though storageState above resets browser state,
    // explicitly clearing cookies guards against any cross-test bleed within
    // the same worker.
    await context.clearCookies();
  });

  test("default tab on /hub is Protocols (no ?tab= param)", async ({
    page,
  }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    const protocolsTab = page.getByRole("tab", { name: "Protocols" });
    await expect(protocolsTab).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
  });

  test("?tab=protocols deep-links to Protocols active", async ({ page }) => {
    await page.goto("/hub?tab=protocols", { waitUntil: "domcontentloaded" });
    const protocolsTab = page.getByRole("tab", { name: "Protocols" });
    await expect(protocolsTab).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
  });

  test("?tab=workflows deep-links to Workflows active", async ({ page }) => {
    await page.goto("/hub?tab=workflows", { waitUntil: "domcontentloaded" });
    const workflowsTab = page.getByRole("tab", { name: "Workflows" });
    await expect(workflowsTab).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
  });

  test("?tab=marketplace deep-links to Marketplace active", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", { waitUntil: "domcontentloaded" });
    const marketplaceTab = page.getByRole("tab", { name: "Marketplace" });
    await expect(marketplaceTab).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
  });

  test("tab click updates URL via router.replace (history length stays constant)", async ({
    page,
  }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    // Wait for tabs to be interactive before snapshotting history length.
    await expect(
      page.getByRole("tab", { name: "Protocols" })
    ).toHaveAttribute("data-state", "active", { timeout: 15_000 });
    const initialHistoryLength = await page.evaluate(() => history.length);

    await page.getByRole("tab", { name: "Workflows" }).click();
    await expect(page).toHaveURL(/[?&]tab=workflows/, { timeout: 5_000 });

    await page.getByRole("tab", { name: "Marketplace" }).click();
    await expect(page).toHaveURL(/[?&]tab=marketplace/, { timeout: 5_000 });

    const finalHistoryLength = await page.evaluate(() => history.length);
    // router.replace MUST NOT push new history entries — HUBV2-03 contract.
    expect(finalHistoryLength).toBe(initialHistoryLength);
  });

  test("HUBV2-02: shell stays mounted across tab switches (sidebar is stable, no shell re-mount)", async ({
    page,
  }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    const sidebar = page.locator('[data-testid="navigation-sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    // Tag the live sidebar DOM node with a marker. If the surrounding shell
    // re-mounts on tab switch, React replaces the DOM node and the marker is
    // lost. A stable mount preserves the marker across all three swaps.
    await sidebar.evaluate((el) => {
      el.setAttribute("data-shell-mount-marker", "persisted");
    });

    await page.getByRole("tab", { name: "Workflows" }).click();
    await expect(page).toHaveURL(/[?&]tab=workflows/, { timeout: 5_000 });
    await expect(sidebar).toHaveAttribute(
      "data-shell-mount-marker",
      "persisted"
    );

    await page.getByRole("tab", { name: "Marketplace" }).click();
    await expect(page).toHaveURL(/[?&]tab=marketplace/, { timeout: 5_000 });
    await expect(sidebar).toHaveAttribute(
      "data-shell-mount-marker",
      "persisted"
    );

    await page.getByRole("tab", { name: "Protocols" }).click();
    await expect(page).toHaveURL(/[?&]tab=protocols/, { timeout: 5_000 });
    await expect(sidebar).toHaveAttribute(
      "data-shell-mount-marker",
      "persisted"
    );
  });

  test("HUBV2-02: tab swap shows no skeleton flicker on the surrounding shell", async ({
    page,
  }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("tab", { name: "Protocols" })
    ).toHaveAttribute("data-state", "active", { timeout: 15_000 });

    // Trigger a tab swap; assert no .animate-pulse element appears at the
    // SHELL level for >100ms. Tab CONTENT may have its own skeleton (e.g.
    // marketplace initial fetch) — we only care that the SURROUNDING shell
    // (anything outside [role="tabpanel"]) does not flicker.
    const shellPulseLocator = page.locator(
      'div:not([role="tabpanel"]) > .animate-pulse, body > .animate-pulse'
    );

    await page.getByRole("tab", { name: "Workflows" }).click();
    // Brief wait so any hypothetical flicker would be caught in this window.
    await page.waitForTimeout(150);
    expect(await shellPulseLocator.count()).toBe(0);

    await page.getByRole("tab", { name: "Marketplace" }).click();
    await page.waitForTimeout(150);
    expect(await shellPulseLocator.count()).toBe(0);
  });

  test("HUBV2-08: no 'Listed in marketplace' badge anywhere in the Workflows tab HTML", async ({
    page,
  }) => {
    await page.goto("/hub?tab=workflows", { waitUntil: "domcontentloaded" });
    // Wait for the Workflows tab content to render (any view-mode wrapper or
    // empty state — both are acceptable; we only care about the badge string).
    await expect(
      page.getByRole("tab", { name: "Workflows" })
    ).toHaveAttribute("data-state", "active", { timeout: 15_000 });
    // Give the Workflows tab a beat to fully stream in.
    await page
      .locator('[data-view-mode]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {
        // If no view-mode wrapper renders (empty results), continue — the
        // badge-absence assertion below is still meaningful.
      });
    const html = await page.content();
    expect(html).not.toMatch(/Listed in marketplace/i);
  });

  test("HUBV2-08 source-grep: MARKETPLACE_BADGE_SLOT marker exists in workflow-template-row.tsx", async () => {
    // Regression guard: future maintainers must not delete the slot marker
    // without re-reading HUBV2-08. The marker stays as a comment; the slot
    // renders nothing in Phase 44.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      "components/hub/workflow-template-row.tsx",
      "utf8"
    );
    expect(src).toMatch(/MARKETPLACE_BADGE_SLOT/);
    expect(src).not.toMatch(/Listed in marketplace/);
  });
});
