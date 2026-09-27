import {
  expect,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

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

function sameOriginPath(href: string, baseURL: string): string | null {
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
  return url.pathname;
}

async function hrefsFrom(page: Page, selector: string): Promise<string[]> {
  return page
    .locator(selector)
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute('href') ?? ''),
    );
}

/** Open every shell menu in turn and read links from all rendered nav groups. */
export async function collectPaths(
  page: Page,
  baseURL: string,
): Promise<string[]> {
  const hrefs: string[] = [];
  const triggers = page.locator(
    'nav[aria-label="Main navigation"] .nav-trigger',
  );
  const count = await triggers.count();
  for (let index = 0; index < count; index += 1) {
    const trigger = triggers.nth(index);
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
      // The desktop menu can be visually collapsed by mobile CSS. Dispatching
      // the same button click still reveals the configured links for crawling.
      await trigger.evaluate((element) => {
        (element as HTMLButtonElement).click();
      });
    }
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    hrefs.push(
      ...(await hrefsFrom(
        page,
        'nav[aria-label="Main navigation"] .mega-menu a[href]',
      )),
    );
  }
  hrefs.push(
    ...(await hrefsFrom(
      page,
      'nav:not([aria-label="Main navigation"]) a[href]',
    )),
  );

  return [...new Set(hrefs.map((href) => sameOriginPath(href, baseURL)))]
    .filter((path): path is string => path !== null)
    .sort();
}

function isSameOrigin(url: string, baseURL: string): boolean {
  try {
    return new URL(url).origin === new URL(baseURL).origin;
  } catch {
    return false;
  }
}

function isLongLivedStream(request: Request): boolean {
  return new URL(request.url()).pathname === '/api/v1/stream';
}

/** Visit one reachable route and reject HTTP, rendering, and accessibility errors. */
export async function visitPath(
  page: Page,
  baseURL: string,
  path: string,
): Promise<void> {
  const failures: string[] = [];
  const pendingApi = new Set<Request>();
  const onRequest = (request: Request): void => {
    if (
      isSameOrigin(request.url(), baseURL) &&
      request.url().includes('/api/') &&
      !isLongLivedStream(request)
    ) {
      pendingApi.add(request);
    }
  };
  const onResponse = (response: Response): void => {
    const request = response.request();
    pendingApi.delete(request);
    if (!isSameOrigin(response.url(), baseURL)) return;
    if (response.status() < 400) return;
    failures.push(`${String(response.status())} ${response.url()}`);
  };
  const onRequestFailed = (request: Request): void => {
    pendingApi.delete(request);
    if (isSameOrigin(request.url(), baseURL))
      failures.push(
        `request failed ${request.url()}: ${request.failure()?.errorText ?? 'unknown error'}`,
      );
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  try {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(response?.status() ?? 0, `${path} document status`).toBe(200);
    expect(
      new URL(page.url()).pathname,
      `${path} should not redirect to a different route`,
    ).toBe(new URL(path, baseURL).pathname);

    await expect(
      page.getByRole('heading').first(),
      `${path} should render a heading`,
    ).toBeVisible();
    await expect(
      page.locator('.ui-message.error-box'),
      `${path} should not render an error state`,
    ).toHaveCount(0);
    await expect(
      page.getByRole('alert').filter({
        hasText:
          /something went wrong|could not be displayed|not found|failed to load|internal server error/i,
      }),
      `${path} should not show an empty or failed error state`,
    ).toHaveCount(0);

    await expect
      .poll(() => pendingApi.size, {
        timeout: 10_000,
        message: `${path} API requests should settle`,
      })
      .toBe(0);
    expect(failures, `${path} same-origin HTTP and request failures`).toEqual(
      [],
    );
    expect(await accessibilityViolations(page), `${path} axe`).toEqual([]);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}
