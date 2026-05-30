#!/usr/bin/env tsx

/**
 * dev-login-browser.ts
 *
 * Sub-process spawned (detached, background) by scripts/dev-login.ts.
 * Owns the Playwright Chromium window: receives the signed cookie value
 * via argv[2], the URL via argv[3], and the profile dir via argv[4],
 * launches a persistent context, sets the cookie, opens the URL, and
 * waits for the browser to close before exiting.
 *
 * Lives in its own process so the parent (dev:login) can return the
 * terminal to the user immediately while the browser stays alive.
 * Detaching via `spawn(..., { detached: true })` is not enough on its
 * own: a Playwright BrowserContext closes when the Node process that
 * owns it exits, so we need a separate Node process that stays alive
 * until the user closes the window.
 */

import "dotenv/config";

import { chromium } from "@playwright/test";

async function main(): Promise<void> {
  const rawSignedValue = process.argv[2];
  const url = process.argv[3];
  const profileDir = process.argv[4];
  if (!(rawSignedValue && url && profileDir)) {
    throw new Error(
      "dev-login-browser: expected argv: <signedCookie> <url> <profileDir>"
    );
  }

  // Mirror the wire encoding used by
  // app/api/auth/oauth-mfa-finalize/route.ts:buildSessionSetCookie.
  const value = encodeURIComponent(rawSignedValue);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
  });

  await ctx.addCookies([
    {
      name: "better-auth.session_token",
      value,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  // Reuse the auto-created blank page if there is one; otherwise open one.
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {
    // Ignore navigation errors: even if the dev server is slow or down,
    // the window itself stays open and the user can refresh manually.
  });

  // Block until Chromium exits. launchPersistentContext returns a
  // contextless browser (ctx.browser() === null), so we wait on the
  // context's own close lifecycle via waitForEvent. The parent
  // dev:login has long since detached; this daemon exits when the
  // user closes the browser window.
  await ctx.waitForEvent("close", { timeout: 0 });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  // biome-ignore lint/suspicious/noConsole: detached daemon, stderr is the only signal
  console.error(msg);
  process.exit(1);
});
