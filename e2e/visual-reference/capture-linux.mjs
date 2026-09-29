// Captures the legacy admin shell on the ubuntu-24.04 x86_64 CI runner for the
// parity suite's header comparison (see parity-baselines.json).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(
    'Linux parity baselines must be captured on the hosted ubuntu-24.04 x86_64 CI runner.',
  );
}
const osRelease = readFileSync('/etc/os-release', 'utf8');
if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  !osRelease.includes('VERSION_ID="24.04"') ||
  existsSync('/.dockerenv')
) {
  throw new Error(
    'Capture Linux parity baselines on the hosted ubuntu-24.04 runner, not in a container.',
  );
}

const fontPackages = Object.fromEntries(
  execFileSync(
    'dpkg-query',
    [
      '-W',
      '-f=${Package}\t${Version}\n',
      'fonts-liberation',
      'fonts-noto-color-emoji',
      'libfontconfig1',
      'libfreetype6',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map((line) => line.split('\t')),
);

const base = process.env.LEGACY_URL ?? 'http://127.0.0.1:5173';
const output = resolve('e2e/visual-reference');
const browser = await chromium.launch();
const runnerOs =
  process.env.ImageOS === 'ubuntu24'
    ? 'ubuntu-24.04'
    : (process.env.ImageOS ?? 'unknown');
const runnerImage = `${runnerOs} (${process.env.ImageOS ?? 'unknown'}/${process.env.ImageVersion ?? 'image version unavailable'})`;

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
          runnerImage,
          sourceCommit: process.env.GITHUB_SHA ?? 'manual',
          architecture: 'x86_64',
          playwrightVersion: '1.63.0',
          chromiumVersion: `${browser.version()} (Playwright revision 1243)`,
          webkitVersion: '26.6 (Playwright revision 2359)',
          lastCapturedActionsRun: process.env.GITHUB_RUN_ID ?? 'manual',
          fontPackages,
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
