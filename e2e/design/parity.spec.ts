import { expect, test } from '@playwright/test';

// The shell showcase is mounted at /__ui in development by the app router.
// These assertions cover the shared visual contract at the reference widths;
// `tokens.test.ts` checks every CSS value against the frozen legacy snapshot.
test('shared UI stays usable and keeps the desktop layout', async ({
  page,
}) => {
  await page.goto('/__ui');
  await expect(
    page.getByRole('heading', { name: 'Design system' }),
  ).toBeVisible();
  await expect(page.locator('.ui-showcase')).toHaveScreenshot(
    'ui-showcase-1440.png',
    { animations: 'disabled' },
  );
  await page.getByRole('button', { name: 'Open dialog' }).click();
  const dialog = page.getByRole('dialog', { name: 'Example dialog' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveScreenshot('ui-dialog-1440.png', {
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('shared UI has no horizontal page overflow on phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__ui');
  await expect(
    page.getByRole('heading', { name: 'Design system' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(page.locator('.ui-showcase')).toHaveScreenshot(
    'ui-showcase-390.png',
    { animations: 'disabled' },
  );
});
