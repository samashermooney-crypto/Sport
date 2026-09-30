import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type TestInfo } from '@playwright/test';
import sharp from 'sharp';

const showcase = (label: string) =>
  `.ui-showcase-section[aria-label="${label}"]`;

async function headerDifferenceRatio(
  actual: Buffer,
  referenceName: string,
  width: number,
  height: number,
): Promise<number> {
  const reference = await readFile(
    resolve('e2e/visual-reference', referenceName),
  );
  const expected = await sharp(reference)
    .extract({ left: 0, top: 0, width, height })
    .removeAlpha()
    .raw()
    .toBuffer();
  const rendered = await sharp(actual)
    .extract({ left: 0, top: 0, width, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(rendered.info.width).toBe(width);
  expect(rendered.info.height).toBe(height);
  let differentPixels = 0;
  for (let offset = 0; offset < expected.length; offset += 3) {
    if (
      Math.max(
        Math.abs((expected[offset] ?? 0) - (rendered.data[offset] ?? 0)),
        Math.abs(
          (expected[offset + 1] ?? 0) - (rendered.data[offset + 1] ?? 0),
        ),
        Math.abs(
          (expected[offset + 2] ?? 0) - (rendered.data[offset + 2] ?? 0),
        ),
        // Ignore small per-channel differences from Chromium text-edge rasterization.
      ) > 32
    ) {
      differentPixels += 1;
    }
  }
  return differentPixels / (width * height);
}

async function attachHeaderMismatch(
  testInfo: TestInfo,
  actual: Buffer,
  referenceName: string,
  width: number,
  height: number,
): Promise<void> {
  const crop = { left: 0, top: 0, width, height };
  const expected = await readFile(
    resolve('e2e/visual-reference', referenceName),
  );
  await Promise.all([
    testInfo.attach(`actual-${String(width)}px-${referenceName}`, {
      body: await sharp(actual).extract(crop).png().toBuffer(),
      contentType: 'image/png',
    }),
    testInfo.attach(`reference-${String(width)}px-${referenceName}`, {
      body: await sharp(expected).extract(crop).png().toBuffer(),
      contentType: 'image/png',
    }),
  ]);
}

function referenceForPlatform(referenceName: string): string {
  return process.platform === 'linux'
    ? referenceName.replace(/\.png$/, '-linux.png')
    : referenceName;
}

test('shell chrome compares against the legacy captures at desktop and phone widths', async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName === 'webkit', 'Reference captures use Chromium.');
  await page.goto('/__ui');
  await expect(
    page.getByRole('heading', { name: 'Design system' }),
  ).toBeVisible();
  for (const [width, height, reference] of [
    [1440, 68, 'dashboard-1440.png'],
    [390, 52, 'dashboard-390.png'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    const rendered = await page.locator('.ui-topbar').screenshot({
      animations: 'disabled',
    });
    const referenceName = referenceForPlatform(reference);
    const difference = await headerDifferenceRatio(
      rendered,
      referenceName,
      width,
      height,
    );
    if (difference >= 0.065) {
      await attachHeaderMismatch(
        testInfo,
        rendered,
        referenceName,
        width,
        height,
      );
    }
    expect(
      difference,
      `${String(width)}px legacy shell mismatch: ${(difference * 100).toFixed(
        2,
      )}% of pixels differ`,
    ).toBeLessThan(0.065);
  }
});

test('public site shell matches the legacy header and navigation at desktop and phone widths', async ({
  page,
  browserName,
}, testInfo) => {
  await page.goto('/__ui?surface=public');
  await expect(
    page.getByRole('heading', { name: 'Northstar Youth Sports' }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Website navigation' }),
  ).toBeVisible();

  for (const [width, height, reference] of [
    [1440, 157, 'public-site-home-1440.png'],
    [390, 179, 'public-site-home-390.png'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    if (browserName !== 'webkit') {
      const rendered = await page.screenshot({ animations: 'disabled' });
      const referenceName = referenceForPlatform(reference);
      const difference = await headerDifferenceRatio(
        rendered,
        referenceName,
        width,
        height,
      );
      if (difference >= 0.065) {
        await attachHeaderMismatch(
          testInfo,
          rendered,
          referenceName,
          width,
          height,
        );
      }
      expect(
        difference,
        `${String(width)}px public-site shell mismatch: ${(difference * 100).toFixed(2)}% of pixels differ`,
      ).toBeLessThan(0.065);
    }
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        targets: nodes.map(({ target }) => target),
      })),
      `axe violations at ${String(width)}px`,
    ).toEqual([]);
  }

  await page.getByRole('link', { name: 'Leagues', exact: true }).click();
  await expect(page).toHaveURL(/#leagues$/);
  await expect(page.locator('#leagues')).toBeInViewport();
});

test('console and public shells localize navigation and accessibility labels', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('athlentry-language', 'es');
  });
  await page.goto('/__ui');
  await page.getByRole('button', { name: 'Buscar en Athlentry' }).click();
  const palette = page.getByRole('dialog', { name: 'Paleta de comandos' });
  const search = palette.getByRole('searchbox', {
    name: 'Buscar páginas y acciones',
  });
  await expect(search).toHaveAttribute(
    'placeholder',
    'Buscar páginas y acciones',
  );
  await search.fill('no existe');
  await expect(palette.getByText('No hay destinos coincidentes')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__ui?surface=public');
  await expect(
    page.getByRole('navigation', { name: 'Navegación del sitio web' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Inicio', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Iniciar sesión como miembro' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Encuentra tu próxima temporada.' }),
  ).toBeVisible();
  await expect(page.locator('.ui-public-site__skip-link')).toHaveText(
    'Saltar al contenido',
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('the showcase is axe-clean at desktop and phone widths', async ({
  page,
}) => {
  await page.goto('/__ui');
  await expect(
    page.getByRole('heading', { name: 'Design system' }),
  ).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.map(({ id, impact, description, nodes }) => ({
        id,
        impact,
        description,
        targets: nodes.map(({ target }) => target),
      })),
      `axe violations at ${String(width)}px`,
    ).toEqual([]);
  }
});

test('interactive controls meet 44px targets at phone width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/__ui');
  await expect(
    page.getByRole('combobox', { name: 'Items per page' }),
  ).toHaveCSS('height', '44px');
  const smallTargets = await page
    .locator(
      'button:visible, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):visible, select:visible, textarea:visible, a[href]:visible',
    )
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width >= 44 && rect.height >= 44) return [];
        const name = (
          element.getAttribute('aria-label') ||
          element.textContent ||
          element.tagName
        ).trim();
        const width = String(Math.round(rect.width));
        const height = String(Math.round(rect.height));
        return [
          `${element.tagName.toLowerCase()} "${name}" ${width}×${height}`,
        ];
      }),
    );
  expect(smallTargets).toEqual([]);

  const smallChoiceLabels = await page
    .locator(
      'label:has(input[type="checkbox"]), label:has(input[type="radio"])',
    )
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width >= 44 && rect.height >= 44
          ? []
          : [
              `${element.textContent.trim() || 'choice'} ${String(Math.round(rect.width))}×${String(Math.round(rect.height))}`,
            ];
      }),
    );
  expect(smallChoiceLabels).toEqual([]);

  for (const [trigger, name] of [
    ['Open dialog', 'Example dialog'],
    ['Open drawer', 'Example drawer'],
    ['Open sheet', 'Example sheet'],
  ] as const) {
    const triggerButton = page.getByRole('button', { name: trigger });
    await triggerButton.focus();
    await page.keyboard.press('Enter');
    const overlay = page.getByRole('dialog', { name });
    await expect(overlay).toBeVisible();
    const closeSize = await overlay
      .getByRole('button', { name: 'Close dialog' })
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    expect(closeSize.width).toBeGreaterThanOrEqual(44);
    expect(closeSize.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(triggerButton).toBeFocused();
  }
});

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
    ['States and feedback', 'ui-feedback-1440.png'],
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

test('tabs support arrow and boundary-key navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/__ui');
  const tabs = page.getByRole('tablist', { name: 'Sections' });
  const overview = tabs.getByRole('tab', { name: 'Overview' });
  const components = tabs.getByRole('tab', { name: 'Components' });
  const states = tabs.getByRole('tab', { name: 'States' });

  await overview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(components).toBeFocused();
  await expect(
    page.getByText('Selected tab: Components', { exact: false }),
  ).toBeVisible();
  await page.keyboard.press('End');
  await expect(states).toBeFocused();
  await page.keyboard.press('Home');
  await expect(overview).toBeFocused();
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
    calendar.getByRole('table', {
      name: 'Resource schedule for Wednesday, January 14, 2026',
    }),
  ).toBeVisible();
  await expect(calendar.getByText('Falcons vs. Rockets')).toBeVisible();
  await expect(calendar.getByText('Rockets practice')).toHaveCount(0);
  await expect(
    calendar.getByRole('columnheader', { name: '9 AM' }),
  ).toBeVisible();
});

test('calendar grid supports keyboard date navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/__ui');
  const calendar = page.locator('.ui-calendar');
  const currentDay = calendar.getByRole('gridcell', {
    name: 'January 14, 2026',
  });
  await currentDay.focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    calendar.getByRole('gridcell', { name: 'January 15, 2026' }),
  ).toBeFocused();
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
    { animations: 'disabled', maxDiffPixels: 2 },
  );
  await expect(page.locator(showcase('States and feedback'))).toHaveScreenshot(
    'ui-feedback-390.png',
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
  await page.keyboard.press('Control+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
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
