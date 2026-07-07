import { expect, test } from "./fixtures";

// The sign-in surface moved from an in-app modal to the inline /welcome
// landing (SignInChoices + ConnectAuthPanel). These cover the email
// signup/verify and sign-in flows on that page. Run serially to avoid session
// state conflicts between the signup flows.
test.describe.configure({ mode: "serial" });

const newEmail = (): string => `test+${Date.now()}@techops.services`;

// Right after navigation the "Create an account" toggle can be clicked before
// the client handler is wired, dropping the click and leaving the main
// (sign-in) view in place. Retry the toggle until the signup heading resolves.
async function openSignupView(
  page: import("@playwright/test").Page
): Promise<void> {
  const toggle = page.getByRole("button", { name: "Create an account" });
  const heading = page.getByRole("heading", { name: "Create your account" });
  await expect(async () => {
    if (await toggle.isVisible()) {
      await toggle.click();
    }
    await expect(heading).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 20_000 });
}

// Same hydration race as the signup toggle: the "Sign in" submit can be dropped
// if it lands before the client handler is wired. Retry it until the expected
// outcome (an error message, or the verify view) resolves.
async function submitSignInUntil(
  page: import("@playwright/test").Page,
  outcome: import("@playwright/test").Locator
): Promise<void> {
  const signInButton = page.getByRole("button", {
    name: "Sign in",
    exact: true,
  });
  await expect(async () => {
    if (await signInButton.isVisible()) {
      await signInButton.click();
    }
    await expect(outcome).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 20_000 });
}

test.describe("Authentication", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test.describe("Email OTP Verification on Signup", () => {
    test("shows verification view after signup with OTP input", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });

      // The email/password form renders inline; switch it to the sign-up view.
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);

      await page.locator("#auth-email").fill(newEmail());
      await page.locator("#auth-password").fill("TestPassword123!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();

      // Verify view: heading, OTP input, a confirmation toast, and resend.
      await expect(
        page.getByRole("heading", { name: "Verify your email" })
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByPlaceholder("123456")).toBeVisible();
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.getByRole("button", { name: "Resend code" })
      ).toBeVisible();
    });

    test("invalid email keeps the user on the signup view", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);

      await page.locator("#auth-email").fill("invalid-email");
      await page.locator("#auth-password").fill("TestPassword123!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();

      // HTML5 email validation blocks submission, so the signup view stays.
      await expect(
        page.getByRole("heading", { name: "Create your account" })
      ).toBeVisible();
    });

    test("existing unverified user signing up again returns to verification", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      const email = newEmail();

      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);
      await page.locator("#auth-email").fill(email);
      await page.locator("#auth-password").fill("TestPassword123!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Verify your email" })
      ).toBeVisible({ timeout: 15_000 });

      // Reload to reset the panel to the sign-in view (the verify view has no
      // back button), then sign up again with the same (still unverified)
      // email: the panel returns to verification rather than erroring.
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);
      await page.locator("#auth-email").fill(email);
      await page.locator("#auth-password").fill("DifferentPassword123!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();

      await expect(
        page.getByRole("heading", { name: "Verify your email" })
      ).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe("Sign In", () => {
    test("renders the email and password form inline", async ({ page }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("#auth-password")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true })
      ).toBeVisible();
    });

    test("shows error for incorrect credentials", async ({ page }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await page.locator("#auth-email").fill("nonexistent@example.com");
      await page.locator("#auth-password").fill("WrongPassword123!");
      await submitSignInUntil(page, page.locator(".text-destructive"));
    });

    test("unverified user signing in redirects to verification", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      const email = newEmail();
      const password = "TestPassword123!";

      // Create an unverified account.
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);
      await page.locator("#auth-email").fill(email);
      await page.locator("#auth-password").fill(password);
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Verify your email" })
      ).toBeVisible({ timeout: 15_000 });

      // Reload to reset the panel to the sign-in view (the verify view has no
      // back button), then sign in with the unverified account.
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await page.locator("#auth-email").fill(email);
      await page.locator("#auth-password").fill(password);

      // The submit can land before the client handler is wired right after
      // navigation; retry it until the verify view resolves.
      await submitSignInUntil(
        page,
        page.getByRole("heading", { name: "Verify your email" })
      );
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({
        timeout: 5000,
      });
    });

    test("can navigate between sign in and create account views", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });

      // Main (sign-in) has no heading on the welcome page; the submit is present.
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true })
      ).toBeVisible({ timeout: 15_000 });

      await openSignupView(page);

      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true })
      ).toBeVisible();
    });
  });
});
