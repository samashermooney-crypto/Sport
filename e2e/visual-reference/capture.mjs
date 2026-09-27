import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

const base = process.env.LEGACY_URL ?? 'http://127.0.0.1:5173';
const output = resolve('e2e/visual-reference');
const org = 'fieldhouse-demo';
const browser = await chromium.launch();
await mkdir(output, { recursive: true });

async function settle(page) {
  await page
    .waitForLoadState('networkidle', { timeout: 5_000 })
    .catch(() => {});
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page, name, width) {
  await settle(page);
  await page.screenshot({
    path: resolve(output, `${name}-${width}.png`),
    animations: 'disabled',
  });
}

async function visit(page, path) {
  await page.goto(new URL(path, base).toString());
  await settle(page);
}

async function firstHref(page, prefix) {
  const href = await page
    .locator(`a[href^="${prefix}"]`)
    .first()
    .getAttribute('href');
  if (!href) throw new Error(`No legacy link begins ${prefix}`);
  return href;
}

async function captureAdmin(width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await visit(page, '/');
  await page.getByRole('heading', { name: 'Welcome back.' }).waitFor();
  await shot(page, 'sign-in', width);
  await page.getByText('Local demonstration account').click();
  await page.getByRole('button', { name: 'Fill demo credentials' }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await shot(page, 'dashboard', width);

  const routes = [
    ['program-list', '/programs'],
    ['program-editor', '/programs/new'],
    ['members-list', '/members'],
    ['schedule', '/schedule'],
    ['website-editor', '/website/editor'],
  ];
  for (const [name, path] of routes) {
    await visit(page, path);
    await shot(page, name, width);
  }

  await visit(page, '/teams');
  const team = await firstHref(page, '/teams/');
  await visit(page, team);
  await shot(page, 'team-profile', width);

  await visit(page, '/invoices');
  const invoice = await firstHref(page, '/invoices/');
  await visit(page, invoice);
  await shot(page, 'invoice-detail', width);

  await visit(page, '/members');
  const archive = page
    .locator('button[title*="Archive"], button[aria-label*="Archive"]')
    .first();
  await archive.click();
  await page.getByRole('dialog').waitFor();
  await shot(page, 'open-modal', width);

  await visit(page, `/site/${org}`);
  await shot(page, 'public-site-home', width);
  await context.close();
}

async function captureMember(width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await visit(page, `/site/${org}/account/signup`);
  const address = `visual-reference-${crypto.randomUUID()}@example.invalid`;
  await page.getByLabel('First name').fill('Visual');
  await page.getByLabel('Last name').fill('Reference');
  await page.getByLabel('Your birthdate').fill('1990-01-01');
  const optional = [
    ['Mobile number', '2025550100'],
    ['Address', '1 Demo Street'],
    ['City', 'Springfield'],
    ['State', 'IL'],
    ['Postal code', '62701'],
    [
      'Secondary email address',
      `backup-${crypto.randomUUID()}@example.invalid`,
    ],
  ];
  for (const [label, value] of optional) {
    const field = page.getByLabel(label, { exact: true });
    if (await field.count()) await field.fill(value);
  }
  await page.getByLabel(/^Email/).fill(address);
  const password = `Visual reference ${crypto.randomUUID()}`;
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('link', { name: 'Verify this demo account' }).waitFor();
  await page.getByRole('link', { name: 'Verify this demo account' }).click();
  await page.getByRole('button', { name: 'Verify email and continue' }).click();
  await visit(page, `/site/${org}/account/dashboard`);
  await page.locator('.member-portal').waitFor();
  await shot(page, 'member-portal-home', width);
  await context.close();
}

try {
  for (const width of [1440, 390]) {
    await captureAdmin(width);
    await captureMember(width);
  }
  await writeFile(
    resolve(output, 'capture.json'),
    JSON.stringify(
      {
        legacyRevision: '9ef77bb',
        viewports: [1440, 390],
        height: 900,
        screenshots: [
          'sign-in',
          'dashboard',
          'program-list',
          'program-editor',
          'members-list',
          'team-profile',
          'invoice-detail',
          'schedule',
          'website-editor',
          'member-portal-home',
          'public-site-home',
          'open-modal',
        ],
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
