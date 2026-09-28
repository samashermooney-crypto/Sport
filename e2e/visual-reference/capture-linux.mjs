// Captures the legacy admin shell on the ubuntu-24.04 x86_64 CI runner for the
// parity suite's header comparison (see parity-baselines.json).
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(
    'Linux parity baselines must be captured on the ubuntu-24.04 x86_64 CI runner.',
  );
}

const base = process.env.LEGACY_URL ?? 'http://127.0.0.1:5173';
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
          runnerImage: 'ubuntu-24.04 (ubuntu24/20260920.314)',
          architecture: 'x86_64',
          playwrightVersion: '1.63.0',
          chromiumVersion: '153.0.8010.12 (Playwright revision 1243)',
          webkitVersion: '26.6 (Playwright revision 2359)',
          lastValidatedActionsRun: process.env.GITHUB_RUN_ID ?? 'manual',
          fontPackages: {
            'fonts-liberation': '1:2.1.5-3',
            'fonts-noto-color-emoji': '2.047-0ubuntu0.24.04.1',
            libfontconfig1: '2.15.0-1.1ubuntu2',
            libfreetype6: '2.13.2+dfsg-1ubuntu0.1',
          },
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
