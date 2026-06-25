import { expect, test } from "./fixtures";
import { getDbConnection } from "./utils/connection";
import { installWalletStub } from "./utils/wallet-stub";

// SIWE wallet login via the Connect modal, exercised with the injected-wallet
// stub (EIP-6963 + personal_sign signed by a throwaway key). Runs logged-out.
test.use({ storageState: { cookies: [], origins: [] } });

const ADDRESS_PREFIX_REGEX = /^0x[a-fA-F0-9]{6}/;

// Force any existing wallet account to re-prompt for a display name, so these
// tests are deterministic whether or not the account already exists.
async function resetWalletAccounts(): Promise<void> {
  const sql = getDbConnection();
  try {
    await sql`update users set display_name_confirmed = false where email ilike '%@wallet.keeperhub.com'`;
  } finally {
    await sql.end();
  }
}

test.describe("wallet login (SIWE)", () => {
  test.beforeEach(async ({ page }) => {
    await resetWalletAccounts();
    await installWalletStub(page);
  });

  test("connects, mints a session, and prompts for a display name", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Open the Connect modal and pick the injected wallet.
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const walletButton = page.getByTestId("connect-wallet-io.metamask");
    await expect(walletButton).toBeVisible({ timeout: 15_000 });
    await walletButton.click();

    // A fresh wallet account must choose a display name before entering (so the
    // audit trail never shows a 0x address).
    const nameModal = page.getByRole("dialog");
    await expect(nameModal).toContainText("Choose a display name", {
      timeout: 20_000,
    });

    const nameInput = page.locator("#wallet-display-name");
    await expect(nameInput).toBeVisible();
    await nameInput.fill("Swift Falcon");
    await page.getByRole("button", { name: "Continue" }).click();

    // Lands in-app as a signed-in user (org switcher present), name modal gone.
    await expect(nameModal).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('button[role="combobox"]')).toBeVisible({
      timeout: 15_000,
    });
  });

  test("seeded display name is never a raw 0x address", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByTestId("connect-wallet-io.metamask").click();

    const nameInput = page.locator("#wallet-display-name");
    await expect(nameInput).toBeVisible({ timeout: 20_000 });
    // The server pre-fills a friendly handle, not the address.
    await expect(nameInput).not.toHaveValue(ADDRESS_PREFIX_REGEX);
  });
});
