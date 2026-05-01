import { expect, test } from "@playwright/test";

// Anonymous storage state — the Marketplace tab is publicly browseable, and
// the privacy assertion below MUST hold for unauthenticated visitors (the
// strictest case — no per-org filtering applies).
test.use({ storageState: { cookies: [], origins: [] } });

// MARKET-13 privacy whitelist: any leak of these column names in the
// rendered HTML for /hub?tab=marketplace fails this suite. Easy to extend
// if a future SELECT adds a new sensitive column.
const BANNED_TOKENS = [
  "creatorWalletAddress",
  "userId",
  "organizationId",
  "payerAddress",
  "amountUsdc",
] as const;

// Top-level regex literals — Biome lint rule
// `lint/performance/useTopLevelRegex` requires regex literals to live at
// module scope so they are compiled once instead of on every test invocation.
const URL_SORT_NEWEST = /[?&]sort=newest/;
const URL_TAB_MARKETPLACE = /[?&]tab=marketplace/;
const URL_SORT_POPULAR = /[?&]sort=popular/;
const URL_TAB_WORKFLOWS = /[?&]tab=workflows/;
const NAME_EARNINGS = /earnings/i;

test.describe("Marketplace tab (MARKET-13)", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("loads /hub?tab=marketplace and renders leaderboard or empty state", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    // Either the leaderboard table renders, or the empty state. Both are
    // acceptable in a cold-start dev environment without seeded payments.
    const leaderboard = page.getByRole("table", {
      name: "Marketplace leaderboard",
    });
    const empty = page.getByText("No paid services listed yet.");
    await expect(leaderboard.or(empty).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("HTML rendered for /hub?tab=marketplace does not leak sensitive columns", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    // Wait for marketplace render to settle — `region` aria-label is set on
    // both the populated and empty states (`<section aria-label="Marketplace results">`).
    await page
      .getByRole("region", { name: "Marketplace results" })
      .waitFor({ state: "visible", timeout: 15_000 });
    const html = await page.content();
    for (const banned of BANNED_TOKENS) {
      expect(
        html,
        `Expected no leak of '${banned}' in /hub?tab=marketplace HTML`
      ).not.toContain(banned);
    }
  });

  test("sort dropdown switches between Popular and Newest, updating ?sort= URL param", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    const trigger = page.getByRole("button", { name: "Sort marketplace by" });
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    // Default sort is Popular.
    await expect(trigger).toContainText("Popular");

    // Switch to Newest.
    await trigger.click();
    const newestOption = page.getByRole("menuitemradio", { name: "Newest" });
    await expect(newestOption).toBeVisible({ timeout: 5000 });
    await newestOption.click();
    await expect(page).toHaveURL(URL_SORT_NEWEST, { timeout: 5000 });
    // URL should still carry tab=marketplace alongside sort=newest.
    await expect(page).toHaveURL(URL_TAB_MARKETPLACE);
    await expect(trigger).toContainText("Newest");

    // Switch back to Popular.
    await trigger.click();
    const popularOption = page.getByRole("menuitemradio", { name: "Popular" });
    await expect(popularOption).toBeVisible({ timeout: 5000 });
    await popularOption.click();
    await expect(page).toHaveURL(URL_SORT_POPULAR, { timeout: 5000 });
    await expect(trigger).toContainText("Popular");
  });

  test("sort dropdown does NOT expose Earnings option (MARKET-02 deferred)", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    const trigger = page.getByRole("button", { name: "Sort marketplace by" });
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();
    // Assert there is no menu item containing "Earnings" / "earnings". The
    // earnings/revenue sort is explicitly deferred (MARKET-FUTURE-01) until
    // privacy review + bucketing-threshold sign-off.
    const earningsOption = page.getByRole("menuitemradio", {
      name: NAME_EARNINGS,
    });
    await expect(earningsOption).toHaveCount(0);
  });

  test("HUBV2-02: tab swap from Marketplace to Workflows does not flicker the shell", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("tab", { name: "Marketplace" })
    ).toHaveAttribute("data-state", "active", { timeout: 15_000 });

    // Sidebar must stay mounted across the swap (stable shell contract).
    const sidebar = page.locator('[data-testid="navigation-sidebar"]');
    await expect(sidebar).toBeVisible();
    await sidebar.evaluate((el) => {
      el.setAttribute("data-shell-mount-marker", "persisted");
    });

    const shellPulseLocator = page.locator(
      'div:not([role="tabpanel"]) > .animate-pulse, body > .animate-pulse'
    );

    await page.getByRole("tab", { name: "Workflows" }).click();
    await page.waitForTimeout(150);
    expect(await shellPulseLocator.count()).toBe(0);
    await expect(page).toHaveURL(URL_TAB_WORKFLOWS);
    // Marker survives → shell did not re-mount.
    await expect(sidebar).toHaveAttribute(
      "data-shell-mount-marker",
      "persisted"
    );
  });
});
