import { expect, test } from "./fixtures";
import { installWalletStub } from "./utils/wallet-stub";

// SIWE wallet login via the welcome page, exercised with the injected-wallet
// stub (EIP-6963 + personal_sign signed by a throwaway key). Runs logged-out.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("wallet login (SIWE)", () => {
  test.beforeEach(async ({ page }) => {
    await installWalletStub(page);
  });

  test("connects, mints a session, and enters onboarding", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });

    // Reveal the wallet picker and pick the injected wallet.
    await page
      .getByRole("button", { name: "Wallet" })
      .click();
    const walletButton = page.getByTestId("connect-wallet-io.metamask");
    await expect(walletButton).toBeVisible({ timeout: 15_000 });
    await walletButton.click();

    // Signed in: a new wallet account lands on the onboarding wizard, keeping
    // its server-generated handle (no display-name prompt, no 0x address).
    await expect(
      page.getByRole("heading", { name: "Name your organization" })
    ).toBeVisible({ timeout: 20_000 });
  });
});
