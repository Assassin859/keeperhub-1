import { expect, test } from "./fixtures";
import { waitForCanvas } from "./utils/workflow";

const ENABLE_BUTTON_REGEX = /^(Enable|Disable) workflow$/;

async function selectTriggerType(
  page: import("@playwright/test").Page,
  optionLabel: string
): Promise<void> {
  const triggerNode = page.locator(".react-flow__node-trigger").first();
  await expect(triggerNode).toBeVisible({ timeout: 10_000 });
  await triggerNode.click();

  const triggerTypeSelect = page.locator("#triggerType");
  await expect(triggerTypeSelect).toBeVisible({ timeout: 5000 });
  await triggerTypeSelect.click();

  const option = page.getByRole("option", { name: optionLabel });
  await expect(option).toBeVisible({ timeout: 3000 });
  await option.click();
}

test.describe("Workflow enable/disable toggle visibility by trigger type", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForCanvas(page);
  });

  test("toggle is visible for Webhook trigger", async ({ page }) => {
    await selectTriggerType(page, "Webhook");
    await expect(page.getByTitle(ENABLE_BUTTON_REGEX)).toBeVisible({
      timeout: 5000,
    });
  });

  test("toggle is visible for Schedule trigger", async ({ page }) => {
    await selectTriggerType(page, "Schedule");
    await expect(page.getByTitle(ENABLE_BUTTON_REGEX)).toBeVisible({
      timeout: 5000,
    });
  });

  test("toggle is visible for Event trigger", async ({ page }) => {
    await selectTriggerType(page, "Event");
    await expect(page.getByTitle(ENABLE_BUTTON_REGEX)).toBeVisible({
      timeout: 5000,
    });
  });

  test("toggle is visible for Block trigger", async ({ page }) => {
    await selectTriggerType(page, "Block");
    await expect(page.getByTitle(ENABLE_BUTTON_REGEX)).toBeVisible({
      timeout: 5000,
    });
  });

  test("toggle is hidden for Manual trigger", async ({ page }) => {
    await selectTriggerType(page, "Manual");
    await expect(page.getByTitle(ENABLE_BUTTON_REGEX)).toHaveCount(0);
  });
});
