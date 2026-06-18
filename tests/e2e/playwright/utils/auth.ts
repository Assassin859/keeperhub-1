import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import postgres from "postgres";
import { getAdminFetchHeaders } from "./admin-fetch";

/**
 * Sign up a new user and navigate to verification view.
 * Returns the test email for later use.
 */
export async function signUp(
  page: Page,
  options?: { email?: string; password?: string }
): Promise<{ email: string; password: string }> {
  const testEmail = options?.email ?? `test+${Date.now()}@techops.services`;
  const testPassword = options?.password ?? "TestPassword123!";

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const signInButton = page.locator('button:has-text("Sign In")').first();
  await expect(signInButton).toBeVisible({ timeout: 15_000 });
  await signInButton.click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Switch to signup view
  const createAccountLink = dialog.locator('button:has-text("Create account")');
  await createAccountLink.click();

  // Fill in signup form
  await dialog.locator("#signup-email").fill(testEmail);
  await dialog.locator("#signup-password").fill(testPassword);

  // Submit the form
  await dialog
    .locator('button[type="submit"]:has-text("Create account")')
    .click();

  // Wait for verify view
  const dialogTitle = dialog.locator("h2");
  await expect(dialogTitle).toHaveText("Verify your email", {
    timeout: 15_000,
  });

  return { email: testEmail, password: testPassword };
}

/**
 * Get OTP for a given email.
 * Uses admin API when TEST_API_KEY + BASE_URL are set (remote/deployed mode).
 * Falls back to direct DB query when DATABASE_URL is available (local mode).
 */
export async function getOtpFromDb(email: string): Promise<string> {
  const adminKey = process.env.TEST_API_KEY;
  const baseUrl = process.env.BASE_URL;

  if (adminKey && baseUrl) {
    return await getOtpViaApi(email, baseUrl);
  }

  return await getOtpViaDb(email);
}

async function getOtpViaApi(email: string, baseUrl: string): Promise<string> {
  const url = `${baseUrl}/api/admin/test/otp?email=${encodeURIComponent(email)}`;
  const maxRetries = 8;
  const baseDelay = 500;

  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, { headers: getAdminFetchHeaders() });
    if (response.ok) {
      const data = (await response.json()) as { otp: string };
      return data.otp;
    }
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`Admin OTP API returned ${response.status}: ${body}`);
    }
    const delay = Math.min(baseDelay * 2 ** i, 4000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(
    `No OTP found for ${email} after ${maxRetries} retries via API`
  );
}

async function getOtpViaDb(email: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or TEST_API_KEY+BASE_URL is required");
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const identifier = `email-verification-otp-${email}`;
    const result = await sql`
      SELECT value FROM verifications
      WHERE identifier = ${identifier}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (result.length === 0) {
      throw new Error(`No verification found for email: ${email}`);
    }

    const rawValue = result[0].value as string;
    if (!rawValue) {
      throw new Error(`No OTP found for email: ${email}`);
    }

    const otp = rawValue.split(":")[0];
    return otp;
  } finally {
    await sql.end();
  }
}

/**
 * Sign up a new user and verify with OTP from database.
 * Returns authenticated user details.
 */
export async function signUpAndVerify(
  page: Page,
  options?: { email?: string; password?: string }
): Promise<{ email: string; password: string }> {
  const { email, password } = await signUp(page, options);

  // Get OTP from database
  const otp = await getOtpFromDb(email);

  // Enter OTP
  const dialog = page.locator('[role="dialog"]');
  const otpInput = dialog.locator("#otp");
  await otpInput.fill(otp);

  // Click verify
  const verifyButton = dialog.locator(
    'button[type="submit"]:has-text("Verify")'
  );
  await verifyButton.click();

  // Wait for dialog to close (successful verification)
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });

  // Wait for org switcher to appear (org auto-created after first sign-in)
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });

  return { email, password };
}

/**
 * Sign in with existing credentials.
 */
export async function signIn(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const signInButton = page.locator('button:has-text("Sign In")').first();
  await expect(signInButton).toBeVisible({ timeout: 15_000 });
  await signInButton.click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });

  await dialog.locator("#email").fill(email);
  await dialog.locator("#password").fill(password);
  await dialog.locator('button[type="submit"]:has-text("Sign in")').click();

  // Wait for dialog to close (successful sign in)
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });

  // Wait for org switcher to appear (indicates session and org are resolved)
  // Use role selector -- data-testid only exists on the "ready" render branch,
  // but role="combobox" achieves the same: only the resolved org switcher has it.
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Sign out the current user.
 */
export async function signOut(page: Page): Promise<void> {
  const userMenu = page.locator('[data-testid="user-menu"]');
  await expect(userMenu).toBeVisible({ timeout: 5000 });
  await userMenu.click();
  const signOutButton = page.locator('button:has-text("Sign out")');
  await expect(signOutButton).toBeVisible({ timeout: 5000 });
  await signOutButton.click();
  await expect(signOutButton).not.toBeVisible({ timeout: 5000 });
}

/**
 * Check if user is currently authenticated.
 */
export async function isAuthenticated(page: Page): Promise<boolean> {
  // Check for authenticated UI elements
  const signInButton = page.locator('button:has-text("Sign In")').first();
  const userMenu = page.locator('[data-testid="user-menu"]');

  // If sign in button is visible, user is not authenticated
  if (await signInButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    return false;
  }

  // If user menu is visible, user is authenticated
  if (await userMenu.isVisible({ timeout: 2000 }).catch(() => false)) {
    return true;
  }

  return false;
}
