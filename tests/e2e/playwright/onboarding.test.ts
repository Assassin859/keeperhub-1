import { expect, test } from "./fixtures";

// Re-enable the onboarding tours for this file. The rest of the suite disables
// them by default (see fixtures.ts) so the driver.js overlay never blocks
// unrelated tests.
test.use({ disableTours: false });

const SIGNIN_SEEN_KEY = "keeperhub-signin-tour-driver-seen";

test.describe("onboarding: sign-in card", () => {
  // Fresh anonymous visitor: the app provisions an anonymous session and the
  // one-card sign-in tour should appear anchored on the Sign In button.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows the sign-in card and does not return once dismissed", async ({
    page,
  }) => {
    // A no-session visitor is walled at /welcome; reach the logged-out canvas
    // (where the one-card sign-in tour is anchored) via the guest path.
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Explore without signing in" })
      .click();
    await expect(page).not.toHaveURL(/\/welcome/, { timeout: 15_000 });

    const popover = page.locator(".driver-popover");
    await expect(popover).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".driver-popover-title")).toContainText(
      "Sign in"
    );

    // "Got it" dismisses it and records the seen flag.
    await page.locator(".driver-popover-next-btn").click();
    await expect(popover).toBeHidden();

    const seen = await page.evaluate(
      (key) => localStorage.getItem(key),
      SIGNIN_SEEN_KEY
    );
    expect(seen).toBe("true");

    // It does not reappear on reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(popover).toBeHidden({ timeout: 5000 });
  });
});

test.describe("onboarding: editor walkthrough", () => {
  // Signed in via the persistent test user (default project storageState).
  test("launches from the getting-started launcher 'Take a tour' button", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Reset launcher + tour state so the launcher is reopenable and the tour
    // has not been seen yet.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("kh:getting-started:")) {
          localStorage.removeItem(key);
        }
      }
      localStorage.removeItem("keeperhub-editor-tour-seen");
    });
    await page.reload({ waitUntil: "domcontentloaded" });

    // The launcher auto-expands for a fresh (never-seen) user; launch the tour
    // from a step's footer.
    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 20_000,
    });
    const takeTour = page
      .getByRole("button", { name: "Take a guided tour" })
      .first();
    await expect(takeTour).toBeVisible({ timeout: 20_000 });
    await takeTour.click();

    // The walkthrough spins up a fresh workflow and shows its first step.
    await expect(page.locator(".driver-popover-title")).toContainText(
      "Workflow Editor Tour",
      { timeout: 30_000 }
    );

    // Advancing past the intro keeps the tour running (next step popover shown).
    await page.locator(".driver-popover-next-btn").click();
    await expect(page.locator(".driver-popover")).toBeVisible();
  });
});
