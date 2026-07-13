// Onboarding tours are suppressed when this cookie is present. Playwright sets
// it by default (see tests/e2e/playwright/fixtures.ts) so the driver.js overlay
// never blocks unrelated tests; the onboarding tests opt out to exercise them.
const DISABLE_TOURS_COOKIE = "kh_disable_tours=1";

export function toursDisabled(): boolean {
  return (
    typeof document !== "undefined" &&
    document.cookie.includes(DISABLE_TOURS_COOKIE)
  );
}
