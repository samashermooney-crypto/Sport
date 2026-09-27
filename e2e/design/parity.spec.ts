import { expect, test } from '@playwright/test';

const showcase = (label: string) =>
  `.ui-showcase-section[aria-label="${label}"]`;

test('shared components preserve the frozen desktop design', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Desktop visual references use Chromium.',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/__ui');
  await expect(
    page.getByRole('heading', { name: 'Design system' }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Team sign-up code' }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  for (const [label, snapshot] of [
    ['Core components', 'ui-core-1440.png'],
    ['Form controls', 'ui-controls-1440.png'],
    ['Scheduling', 'ui-scheduling-1440.png'],
    ['Team and tournament views', 'ui-team-1440.png'],
    ['Communication and records', 'ui-communication-1440.png'],
    ['Documents and search', 'ui-documents-1440.png'],
  ] as const) {
    await expect(page.locator(showcase(label))).toHaveScreenshot(snapshot, {
      animations: 'disabled',
    });
  }

  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.getByRole('button', { name: 'Open dialog' }).click();
  const dialog = page.getByRole('dialog', { name: 'Example dialog' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveScreenshot('ui-dialog-1440.png', {
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.getByRole('button', { name: 'Open drawer' }).click();
  const drawer = page.getByRole('dialog', { name: 'Example drawer' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveScreenshot('ui-drawer-1440.png', {
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.getByRole('button', { name: 'Open sheet' }).click();
  const sheet = page.getByRole('dialog', { name: 'Example sheet' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveScreenshot('ui-sheet-1440.png', {
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('calendar supports all schedule views and the resource time grid', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Calendar interaction is covered in Chromium.',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/__ui');
  const calendar = page.locator('.ui-calendar');

  await page.getByRole('button', { name: 'week' }).click();
  await expect(calendar.getByRole('gridcell')).toHaveCount(7);
  await page.getByRole('button', { name: 'day', exact: true }).click();
  await expect(calendar.getByRole('gridcell')).toHaveCount(1);
  await page.getByRole('button', { name: 'agenda' }).click();
  await expect(calendar.getByText('Falcons vs. Rockets')).toBeVisible();
  await page.getByRole('button', { name: 'resource' }).click();
  await expect(
    calendar.getByRole('grid', {
      name: 'Resource schedule for Wednesday, January 14, 2026',
    }),
  ).toBeVisible();
  await expect(calendar.getByText('Falcons vs. Rockets')).toBeVisible();
  await expect(
    calendar.getByRole('columnheader', { name: '9 AM' }),
  ).toBeVisible();
});

test('team board has a keyboard move path and global search returns results', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Board interaction is covered in Chromium.',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/__ui');

  await page.getByLabel('Move Jordan Lee to').selectOption('team-a');
  const falcons = page
    .locator('.ui-board > section')
    .filter({ hasText: 'Falcons' });
  await expect(falcons.getByText('Jordan Lee')).toBeVisible();

  const search = page
    .getByRole('search')
    .filter({ has: page.getByLabel('Global search') });
  await search.getByLabel('Global search').fill('Spring');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(
    search.getByRole('link', { name: 'Spring soccer · Program' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Insert table' }).click();
  await expect(page.locator('.ui-rich-editable table tbody tr')).toHaveCount(3);

  await page.getByLabel('Typed signature').fill('Dana Morales');
  await page.getByRole('button', { name: 'Clear signature' }).click();
  await expect(page.getByLabel('Typed signature')).toHaveValue('');
});

test('shell stays within phone width and exposes bottom tabs and keyboard palette', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__ui');
  await expect(
    page.getByRole('heading', { name: 'Design system' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Mobile navigation' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  await expect(page.locator('.ui-topbar')).toHaveScreenshot(
    'ui-shell-topbar-390.png',
    { animations: 'disabled' },
  );
  await expect(page.locator('.ui-mobile-tabs')).toHaveScreenshot(
    'ui-shell-tabs-390.png',
    { animations: 'disabled' },
  );
  await page.addStyleTag({
    content: '.ui-topbar, .ui-mobile-tabs { display: none !important; }',
  });
  await expect(page.locator(showcase('Form controls'))).toHaveScreenshot(
    'ui-controls-390.png',
    { animations: 'disabled' },
  );

  await page.keyboard.press('/');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeHidden();
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.getByRole('button', { name: 'Open sheet' }).click();
  const sheet = page.getByRole('dialog', { name: 'Example sheet' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveScreenshot('ui-sheet-390.png', {
    animations: 'disabled',
  });
});
