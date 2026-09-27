import { expect, type Page, type Response } from '@playwright/test';

import { accessibilityViolations } from '../axe';

const skippedPrefixes = [
  '/magic/',
  '/verify/',
  '/verify-email-change/',
  '/reset/',
  '/invitations/',
  '/ownership-transfer/',
  '/guardian-invitations/',
  '/cards/verify/',
];

export function sameOriginPath(href: string, baseURL: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('mailto:')) return null;
  let url: URL;
  try {
    url = new URL(href, baseURL);
  } catch {
    return null;
  }
  const base = new URL(baseURL);
  if (url.origin !== base.origin) return null;
  if (skippedPrefixes.some((prefix) => url.pathname.startsWith(prefix)))
    return null;
  return `${url.pathname}${url.search}`;
}

export async function openNavigation(page: Page): Promise<void> {
  const triggers = page.locator('.nav-trigger');
  const count = await triggers.count();
  for (let index = 0; index < count; index += 1) {
    const trigger = triggers.nth(index);
    if ((await trigger.getAttribute('aria-expanded')) === 'true') continue;
    await trigger.click();
  }
}

export async function collectPaths(
  page: Page,
  baseURL: string,
): Promise<string[]> {
  await openNavigation(page);
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute('href') ?? ''),
    );
  const paths = new Set<string>();
  for (const href of hrefs) {
    const path = sameOriginPath(href, baseURL);
    if (path) paths.add(path);
  }
  return [...paths];
}

export async function visitPath(page: Page, path: string): Promise<void> {
  const serverErrors: string[] = [];
  const onResponse = (response: Response): void => {
    const url = response.url();
    if (!url.includes('/api/') && !url.includes('/healthz')) return;
    if (response.status() < 500) return;
    serverErrors.push(`${String(response.status())} ${url}`);
  };
  page.on('response', onResponse);
  try {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(response?.status() ?? 0, `${path} document status`).toBeLessThan(
      500,
    );
    await expect(
      page.getByRole('heading').first(),
      `${path} should render a heading`,
    ).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Something went wrong' }),
      `${path} should not show the generic error state`,
    ).toHaveCount(0);
    expect(serverErrors, `${path} API errors`).toEqual([]);
    expect(await accessibilityViolations(page), `${path} axe`).toEqual([]);
  } finally {
    page.off('response', onResponse);
  }
}
