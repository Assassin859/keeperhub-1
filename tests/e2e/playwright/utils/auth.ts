import { createHmac } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { symmetricDecrypt } from "better-auth/crypto";
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

async function getEncryptedOtpFromDb(identifier: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or TEST_API_KEY+BASE_URL is required");
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const result = await sql`
      SELECT value FROM verifications
      WHERE identifier = ${identifier}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (result.length === 0) {
      throw new Error(`No verification found for identifier: ${identifier}`);
    }

    const rawValue = result[0].value as string;
    if (!rawValue) {
      throw new Error(`No OTP found for identifier: ${identifier}`);
    }

    // Better Auth's emailOTP plugin stores the value as `<encrypted>:<keyVersion>`
    // when storeOTP is "encrypted" (lib/auth.ts, KEEP-625). Strip the version
    // suffix and symmetric-decrypt the ciphertext with BETTER_AUTH_SECRET to
    // recover the plaintext 6-digit code -- the same primitive the app's
    // strict-signin verifier uses to read it back.
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) {
      throw new Error("BETTER_AUTH_SECRET is required to decrypt the OTP");
    }
    const ciphertext = rawValue.split(":")[0];
    const otp = await symmetricDecrypt({ key: secret, data: ciphertext });
    return otp;
  } finally {
    await sql.end();
  }
}

async function getOtpViaDb(email: string): Promise<string> {
  return await getEncryptedOtpFromDb(`email-verification-otp-${email}`);
}

/**
 * Read and decrypt the strict-signin email OTP (identifier
 * `sign-in-otp-<email>`) that /api/auth/strict-signin/start seeds. DB-only: the
 * admin OTP API only exposes the email-verification code, so the sign-in factor
 * must be read straight from the verifications table. Requires DATABASE_URL +
 * BETTER_AUTH_SECRET (both present in the e2e job).
 */
export async function getSignInOtpFromDb(email: string): Promise<string> {
  return await getEncryptedOtpFromDb(`sign-in-otp-${email}`);
}

/**
 * Fill a (possibly segmented) OTP input reliably. The shadcn InputOTP component
 * intermittently drops digits when populated with a single fill(), which leaves
 * the submit button disabled and hangs the subsequent click. Type the code and
 * assert it landed, retrying the whole sequence until the input holds the full
 * value.
 */
export async function fillOtpInput(
  otpInput: Locator,
  otp: string
): Promise<void> {
  await expect(async () => {
    await otpInput.fill("");
    await otpInput.pressSequentially(otp, { delay: 25 });
    await expect(otpInput).toHaveValue(otp);
  }).toPass({ timeout: 15_000 });
}

/**
 * Fill the sign-in email-OTP field (components/auth/email-otp-field.tsx). That
 * field is a `<div contentEditable>` (deliberately not an <input>, so password
 * managers cannot autofill it), so it has no `value` -- type into it and assert
 * its text, retrying until the digits land.
 */
export async function fillContentEditableOtp(
  field: Locator,
  otp: string
): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.press("ControlOrMeta+a");
    await field.pressSequentially(otp, { delay: 25 });
    await expect(field).toHaveText(otp);
  }).toPass({ timeout: 15_000 });
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;

/**
 * Decode an RFC 4648 base32 string (no padding) to its raw bytes. The TOTP
 * setup key the enrollment dialog renders is base32EncodeUtf8(secret); decoding
 * it yields the exact HMAC key the server verifies against (the app stores the
 * secret and uses it directly as the HMAC key -- see lib/security/totp-verify).
 */
function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      continue;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Generate the current 6-digit TOTP for a base32 setup key, matching the
 * server's RFC 6238 implementation (HMAC-SHA1, 30s period, dynamic truncation).
 * Validated against the app's generateTotp for byte-identical output.
 */
function generateTotpCode(manualEntryKey: string): string {
  const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(manualEntryKey))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (truncated % 1_000_000).toString().padStart(6, "0");
}

/**
 * Complete the mandatory TOTP enrollment wizard that follows a fresh signup
 * (components/settings/totp-setup-dialog.tsx). Reads the rendered setup key,
 * submits a matching code, and dismisses the backup-codes step so the auth
 * dialog closes. Assumes the enrollment step is already on screen. Returns the
 * base32 setup key so callers can generate codes for a later sign-in step-up.
 */
export async function completeTotpEnrollment(page: Page): Promise<string> {
  const dialog = page.locator('[role="dialog"]');
  const manualEntryKey = (
    await dialog
      .locator('button[aria-label="Copy setup key"]')
      .first()
      .textContent()
  )?.replace(/\s/g, "");
  if (!manualEntryKey) {
    throw new Error("Could not read the TOTP setup key from the dialog");
  }
  await page.locator("#totp-verify-code").fill(generateTotpCode(manualEntryKey));
  await dialog.locator('button:has-text("Continue")').click();
  // Backup-codes step: dismiss it to finish enrollment and close the dialog.
  const finishButton = dialog.locator('button:has-text("Skip")');
  await expect(finishButton).toBeVisible({ timeout: 15_000 });
  await finishButton.click();
  return manualEntryKey;
}

/**
 * Sign up a new user and verify with OTP from database.
 * Returns authenticated user details plus the TOTP setup key from the mandatory
 * enrollment step (empty string if enrollment did not appear), so callers can
 * later drive this user through a sign-in TOTP step-up.
 */
export async function signUpAndVerify(
  page: Page,
  options?: { email?: string; password?: string }
): Promise<{ email: string; password: string; totpKey: string }> {
  const { email, password } = await signUp(page, options);

  // Get OTP from database
  const otp = await getOtpFromDb(email);

  // Enter OTP
  const dialog = page.locator('[role="dialog"]');
  const otpInput = dialog.locator("#otp");
  await fillOtpInput(otpInput, otp);

  // Click verify
  const verifyButton = dialog.locator(
    'button[type="submit"]:has-text("Verify")'
  );
  await verifyButton.click();

  // Fresh signups are forced through TOTP enrollment after email verification
  // (components/settings/totp-setup-dialog.tsx). Complete it when it appears so
  // the auth dialog can close; gated so any flow without it is unaffected.
  const totpRequired = await page
    .locator("#totp-verify-code")
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  let totpKey = "";
  if (totpRequired) {
    totpKey = await completeTotpEnrollment(page);
  }

  // Wait for dialog to close (successful verification)
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });

  // Wait for org switcher to appear (org auto-created after first sign-in)
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });

  return { email, password, totpKey };
}

/**
 * Drive the shared AuthDialog through the full strict three-factor sign-in
 * (password -> email OTP -> TOTP) for an existing, TOTP-enrolled user. Assumes
 * the dialog is already open on the sign-in view. Does not assert post-sign-in
 * navigation -- the redirect target depends on the entry point that opened it.
 */
export async function completeMfaSignInDialog(
  page: Page,
  credentials: { email: string; password: string; totpKey: string }
): Promise<void> {
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog.locator("#password")).toBeVisible({ timeout: 15_000 });

  await dialog.locator("#email").fill(credentials.email);
  await dialog.locator("#password").fill(credentials.password);
  await dialog.locator('button[type="submit"]:has-text("Sign in")').click();

  // Email-OTP factor: strict-signin/start seeded a `sign-in-otp` row; read and
  // submit it once the email-code step renders.
  const emailOtpInput = dialog.locator("#signin-email-otp-input");
  await expect(emailOtpInput).toBeVisible({ timeout: 15_000 });
  await fillContentEditableOtp(
    emailOtpInput,
    await getSignInOtpFromDb(credentials.email)
  );
  await dialog.locator('button[type="submit"]:has-text("Continue")').click();

  // TOTP factor: generate the current code from the enrollment secret.
  const totpInput = dialog.locator("#signin-totp");
  await expect(totpInput).toBeVisible({ timeout: 15_000 });
  await fillOtpInput(totpInput, generateTotpCode(credentials.totpKey));
  await dialog.locator('button[type="submit"]:has-text("Verify")').click();
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
