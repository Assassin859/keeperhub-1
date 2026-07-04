import { expect, test } from "./fixtures";

// Logged-out visitors are routed to the welcome landing; the guest link drops
// them into the app without an account. Runs with a fresh anonymous context.
test.use({ storageState: { cookies: [], origins: [] } });

const WELCOME_ROOT = /\/welcome$/;
const WELCOME_ANY = /\/welcome/;

test.describe("welcome landing", () => {
  test("redirects a logged-out visitor from / to /welcome", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(WELCOME_ROOT, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Sign in to KeeperHub" })
    ).toBeVisible();
  });

  test("offers email, wallet, and guest entry points", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    // The email/password form renders inline alongside social + wallet buttons.
    await expect(page.locator("#auth-email")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Wallet" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Explore without signing in" })
    ).toBeVisible();
  });

  test("wallet button reveals the wallet picker", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    const walletButton = page.getByRole("button", { name: "Wallet" });
    await expect(walletButton).toBeVisible({ timeout: 15_000 });
    // Retry to tolerate the post-navigation hydration race on the first click.
    await expect(async () => {
      if (await walletButton.isVisible()) {
        await walletButton.click();
      }
      await expect(
        page.getByText("Nothing leaves your device but a signature.")
      ).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Other ways to sign in" })
    ).toBeVisible();
  });

  test("guest link leaves /welcome for the app", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    const guestButton = page.getByRole("button", {
      name: "Explore without signing in",
    });
    await expect(guestButton).toBeVisible({ timeout: 15_000 });
    // Retry to tolerate the post-navigation hydration race on the first click.
    await expect(async () => {
      if (await guestButton.isVisible()) {
        await guestButton.click();
      }
      await expect(page).not.toHaveURL(WELCOME_ANY, { timeout: 4000 });
    }).toPass({ timeout: 30_000 });
  });
});
