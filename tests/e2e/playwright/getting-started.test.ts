import { expect, test } from "./fixtures";

// KEEP-878: the first-run "Get started" launcher. Signed in as the persistent
// test user (default storageState). The launcher is a bottom-right pill that
// expands to a three-branch checklist and persists its state per user.

// Clear any persisted launcher state so each test starts from the default
// (collapsed pill), regardless of what a prior run left behind.
async function resetLauncher(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("kh:getting-started:")) {
        localStorage.removeItem(key);
      }
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
}

test.describe("getting-started launcher", () => {
  test.beforeEach(async ({ page }) => {
    await resetLauncher(page);
  });

  test("pill expands to the three-branch checklist", async ({ page }) => {
    const pill = page.getByTestId("gs-launcher-pill");
    await expect(pill).toBeVisible({ timeout: 20_000 });

    await pill.click();
    const card = page.getByTestId("gs-launcher-card");
    await expect(card).toBeVisible();

    // All three goal branches are present as tabs.
    await expect(
      card.getByRole("tab", { name: "Connect an agent" })
    ).toBeVisible();
    await expect(card.getByRole("tab", { name: "Monitor" })).toBeVisible();
    await expect(card.getByRole("tab", { name: "Yield" })).toBeVisible();

    // Default branch shows the agent path's first step.
    await expect(page.getByTestId("gs-step-wallet-ready")).toBeVisible();
  });

  test("switching branches swaps the visible steps", async ({ page }) => {
    await page.getByTestId("gs-launcher-pill").click();
    const card = page.getByTestId("gs-launcher-card");

    await card.getByRole("tab", { name: "Monitor" }).click();
    await expect(page.getByTestId("gs-step-connect-alerts")).toBeVisible();

    await card.getByRole("tab", { name: "Yield" }).click();
    await expect(page.getByTestId("gs-step-fund-wallet")).toBeVisible();
  });

  test("wallet-ready step is pre-checked from real state", async ({ page }) => {
    // The Turnkey wallet is auto-provisioned at signup, so the agent branch's
    // first step resolves complete without any user action.
    await page.getByTestId("gs-launcher-pill").click();
    const walletStep = page.getByTestId("gs-step-wallet-ready");
    await expect(walletStep).toBeVisible();
    await expect(walletStep).toHaveAttribute("data-complete", "true", {
      timeout: 15_000,
    });
  });

  test("dismiss hides the launcher and persists across reload", async ({
    page,
  }) => {
    await page.getByTestId("gs-launcher-pill").click();
    await page
      .getByTestId("gs-launcher-card")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();

    await expect(page.getByTestId("gs-launcher-card")).toBeHidden();
    await expect(page.getByTestId("gs-launcher-pill")).toBeHidden();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("gs-launcher-pill")).toBeHidden({
      timeout: 5000,
    });
  });

  test("reopens from the user menu after dismissal", async ({ page }) => {
    await page.getByTestId("gs-launcher-pill").click();
    await page
      .getByTestId("gs-launcher-card")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(page.getByTestId("gs-launcher-pill")).toBeHidden();

    await page.getByTestId("user-menu").click();
    await page.getByRole("menuitem", { name: "Getting started" }).click();

    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 10_000,
    });
  });
});
