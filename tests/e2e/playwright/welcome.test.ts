import { expect, test } from "./fixtures";

// Logged-out visitors are routed to the welcome landing; the guest link drops
// them into the app without an account. Runs with a fresh anonymous context.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("welcome landing", () => {
  test("redirects a logged-out visitor from / to /welcome", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Sign in to KeeperHub" })
    ).toBeVisible();
  });

  test("offers email, wallet, and guest entry points", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("button", { name: "Continue with email" })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Sign in with your wallet" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Explore without signing in" })
    ).toBeVisible();
  });

  test("wallet button reveals the wallet picker", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Sign in with your wallet" })
      .click();
    await expect(
      page.getByText("Nothing leaves your device but a signature.")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Other ways to sign in" })
    ).toBeVisible();
  });

  test("guest link leaves /welcome for the app", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Explore without signing in" })
      .click();
    await expect(page).not.toHaveURL(/\/welcome/, { timeout: 15_000 });
  });
});
