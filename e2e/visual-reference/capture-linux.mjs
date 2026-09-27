// Captures the legacy admin shell on Linux Chromium for the parity suite's
// header comparison. Run inside the mcr.microsoft.com/playwright container
// (see parity-baselines.json) with LEGACY_URL pointing at the legacy app.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

const base = process.env.LEGACY_URL ?? 'http://host.docker.internal:9513';
const output = resolve('e2e/visual-reference');
const browser = await chromium.launch();

async function captureDashboard(width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  await page.goto(new URL('/', base).toString());
  await page.getByRole('heading', { name: 'Welcome back.' }).waitFor();
  await page.getByText('Local demonstration account').click();
  await page.getByRole('button', { name: 'Fill demo credentials' }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page
    .waitForLoadState('networkidle', { timeout: 5_000 })
    .catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: resolve(output, `dashboard-${String(width)}-linux.png`),
    animations: 'disabled',
  });
  await context.close();
}

try {
  for (const width of [1440, 390]) {
    await captureDashboard(width);
  }
  await writeFile(
    resolve(output, 'parity-baselines.json'),
    JSON.stringify(
      {
        legacyRevision: '9ef77bb',
        linux: {
          container: 'mcr.microsoft.com/playwright:v1.63.0-noble',
          platform: 'linux/amd64',
          viewportHeight: 900,
          shellFiles: ['dashboard-1440-linux.png', 'dashboard-390-linux.png'],
        },
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
