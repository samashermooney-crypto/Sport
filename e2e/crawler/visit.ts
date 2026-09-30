import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { accessibilityViolations } from '../axe';

const CANCELLED_REQUEST_ERRORS = new Set([
  'net::ERR_ABORTED',
  'Load request cancelled',
]);

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

/** Open every shell menu in turn and read links from all rendered nav groups. */
export type NavigationDestination = {
  href: string;
  label: string;
  navigationIndex: number;
  navigationLabel: string;
  groupLabel: string | null;
  path: string;
};

type RawNavigationLink = {
  href: string;
  label: string;
};

function destination(
  link: RawNavigationLink,
  baseURL: string,
  navigationIndex: number,
  navigationLabel: string,
  groupLabel: string | null,
): NavigationDestination | null {
  const path = sameOriginPath(link.href, baseURL);
  return path
    ? {
        ...link,
        path,
        navigationIndex,
        navigationLabel,
        groupLabel,
      }
    : null;
}

async function linksIn(
  nav: Locator,
  baseURL: string,
  navigationIndex: number,
  navigationLabel: string,
  groupLabel: string | null,
): Promise<NavigationDestination[]> {
  const links = await nav
    .locator('.mega-menu:visible a[href]:visible')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => ({
        href: anchor.getAttribute('href') ?? '',
        label:
          anchor.getAttribute('aria-label')?.trim() ||
          anchor.textContent.replace(/\s+/g, ' ').trim() ||
          '',
      })),
    );
  return links
    .map((link) =>
      destination(link, baseURL, navigationIndex, navigationLabel, groupLabel),
    )
    .filter((link): link is NavigationDestination => link !== null);
}

/** Reveal rendered navigation groups and return every same-origin destination. */
export async function collectPaths(
  page: Page,
  baseURL: string,
): Promise<NavigationDestination[]> {
  const destinations: NavigationDestination[] = [];
  const navs = page.locator('nav:visible');
  const navCount = await navs.count();
  for (let navIndex = 0; navIndex < navCount; navIndex += 1) {
    const nav = navs.nth(navIndex);
    const navigationLabel = (await nav.getAttribute('aria-label')) ?? '';
    const triggers = nav.locator('button[aria-expanded]:visible');
    const triggerCount = await triggers.count();
    for (let triggerIndex = 0; triggerIndex < triggerCount; triggerIndex += 1) {
      const trigger = triggers.nth(triggerIndex);
      await expect(
        trigger,
        'navigation disclosure has an accessible name',
      ).toHaveAccessibleName(/\S+/);
      const groupLabel = (await trigger.innerText())
        .replace(/\s+/g, ' ')
        .trim();
      const wasExpanded =
        (await trigger.getAttribute('aria-expanded')) === 'true';
      if (wasExpanded) {
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      }
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      destinations.push(
        ...(await linksIn(nav, baseURL, navIndex, navigationLabel, groupLabel)),
      );
    }
    const directLinks = await nav
      .locator('a[href]:visible')
      .evaluateAll((anchors) =>
        anchors
          .filter((anchor) => !anchor.closest('.mega-menu'))
          .map((anchor) => ({
            href: anchor.getAttribute('href') ?? '',
            label:
              anchor.getAttribute('aria-label')?.trim() ||
              anchor.textContent.replace(/\s+/g, ' ').trim() ||
              '',
          })),
      );
    destinations.push(
      ...directLinks
        .map((link) =>
          destination(link, baseURL, navIndex, navigationLabel, null),
        )
        .filter((link): link is NavigationDestination => link !== null),
    );
  }

  const unique = new Map<string, NavigationDestination>();
  for (const link of destinations) {
    const key = [
      link.navigationIndex,
      link.groupLabel ?? '',
      link.href,
      link.label,
    ].join('\u0000');
    unique.set(key, link);
  }
  return [...unique.values()];
}

/** Return visible same-origin links from route content outside shell navigation. */
export async function collectContentPaths(
  page: Page,
  baseURL: string,
): Promise<string[]> {
  const hrefs = await page
    .locator('a[href]:visible')
    .evaluateAll((anchors) =>
      anchors
        .filter(
          (anchor) =>
            !anchor.closest('nav') && !anchor.hasAttribute('download'),
        )
        .map((anchor) => anchor.getAttribute('href') ?? ''),
    );
  return [
    ...new Set(
      hrefs
        .map((href) => sameOriginPath(href, baseURL))
        .filter(
          (path): path is string =>
            path !== null &&
            !path.startsWith('/api/') &&
            !/\.(?:pdf|csv|xlsx?|docx?|zip|png|jpe?g|webp|ics)$/i.test(path),
        ),
    ),
  ];
}

/** Exercise rendered navigation buttons that are not disclosure triggers. */
export async function clickNavigationButtons(
  page: Page,
  baseURL: string,
  sourcePath: string,
): Promise<string[]> {
  const exercised = new Set<string>();
  const contentPaths = new Set<string>();
  let discoveredEnabledButton = true;
  while (discoveredEnabledButton) {
    discoveredEnabledButton = false;
    const navs = page.locator('nav:visible');
    for (let navIndex = 0; navIndex < (await navs.count()); navIndex += 1) {
      const nav = navs.nth(navIndex);
      const buttons = nav.locator('button:visible:not([aria-expanded])');
      for (
        let buttonIndex = 0;
        buttonIndex < (await buttons.count());
        buttonIndex += 1
      ) {
        const button = buttons.nth(buttonIndex);
        await expect(
          button,
          'navigation button has an accessible name',
        ).toHaveAccessibleName(/\S+/);
        const name = (await button.innerText()).replace(/\s+/g, ' ').trim();
        const identity = `${String(navIndex)}\u0000${String(buttonIndex)}\u0000${name}`;
        if (exercised.has(identity)) continue;
        if (await button.isDisabled()) {
          await expect(button).toBeDisabled();
          continue;
        }

        exercised.add(identity);
        discoveredEnabledButton = true;
        const menuDismiss = page.locator('button.ui-menu-dismiss:visible');
        if (await menuDismiss.count()) {
          await menuDismiss.click();
          await expect(menuDismiss).toHaveCount(0);
        }
        const hadActiveButton =
          (await nav.locator('button[aria-current="page"]').count()) > 0;
        const role = await button.getAttribute('role');
        await visitPath(page, baseURL, sourcePath, async () => {
          await button.click();
          await expect
            .poll(() => new URL(page.url()).pathname)
            .toBe(new URL(sourcePath, baseURL).pathname);
          if (role === 'tab')
            await expect(button).toHaveAttribute('aria-selected', 'true');
          else if (hadActiveButton)
            await expect(button).toHaveAttribute('aria-current', 'page');
          return null;
        });
        for (const path of await collectContentPaths(page, baseURL))
          contentPaths.add(path);
      }
    }
  }
  return [...contentPaths];
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
  activate?: () => Promise<Response | null>,
): Promise<void> {
  const failures: string[] = [];
  const networkQuietPeriodMs = 500;
  let lastSameOriginActivityAt = Date.now();
  const trackedRequests = new Set<Request>();
  const successfulRequests = new Set<string>();
  const abortedRequests = new Set<string>();
  const requestKey = (request: Request): string =>
    `${request.method()} ${request.url()}`;
  const onRequest = (request: Request): void => {
    if (!isSameOrigin(request.url(), baseURL) || isLongLivedStream(request))
      return;
    trackedRequests.add(request);
    lastSameOriginActivityAt = Date.now();
  };
  const onResponse = (response: Response): void => {
    const request = response.request();
    if (trackedRequests.delete(request)) lastSameOriginActivityAt = Date.now();
    if (!isSameOrigin(response.url(), baseURL)) return;
    if (response.status() < 400) successfulRequests.add(requestKey(request));
    if (response.status() < 400) return;
    failures.push(`${String(response.status())} ${response.url()}`);
  };
  const onRequestFailed = (request: Request): void => {
    const trackedDuringVisit = trackedRequests.delete(request);
    if (trackedDuringVisit) lastSameOriginActivityAt = Date.now();
    if (!trackedDuringVisit || isLongLivedStream(request)) return;
    // Chromium reports a client-side cancellation as net::ERR_ABORTED and
    // WebKit as "Load request cancelled"; both still need a successful retry.
    if (
      isSameOrigin(request.url(), baseURL) &&
      CANCELLED_REQUEST_ERRORS.has(request.failure()?.errorText ?? '')
    ) {
      abortedRequests.add(requestKey(request));
    } else if (isSameOrigin(request.url(), baseURL)) {
      failures.push(
        `request failed ${request.url()}: ${request.failure()?.errorText ?? 'unknown error'}`,
      );
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  try {
    if (activate) {
      const response = await activate();
      if (response)
        expect(response.status(), `${path} document status`).toBe(200);
    } else {
      const response = await page.goto(path, {
        waitUntil: 'domcontentloaded',
      });
      expect(response?.status() ?? 0, `${path} document status`).toBe(200);
    }
    expect(
      new URL(page.url()).pathname,
      `${path} should not redirect to a different route`,
    ).toBe(new URL(path, baseURL).pathname);

    await expect(
      page.getByRole('heading').first(),
      `${path} should render a heading`,
    ).toBeVisible();
    await expect(
      page.locator('[aria-busy="true"]:visible'),
      `${path} visible data regions should finish loading`,
    ).toHaveCount(0);
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
      .poll(
        () =>
          trackedRequests.size === 0 &&
          Date.now() - lastSameOriginActivityAt >= networkQuietPeriodMs,
        {
          timeout: 10_000,
          intervals: [50],
          message: `${path} same-origin requests should settle and remain quiet`,
        },
      )
      .toBe(true);
    for (const key of abortedRequests) {
      if (!successfulRequests.has(key))
        failures.push(`request aborted without a successful retry ${key}`);
    }
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

/** Click a real navigation link, verify its destination, then return to its source. */
export async function clickNavigationDestination(
  page: Page,
  baseURL: string,
  sourcePath: string,
  destination: NavigationDestination,
): Promise<void> {
  const nav = page.locator('nav:visible').nth(destination.navigationIndex);
  if (destination.groupLabel) {
    const trigger = nav.getByRole('button', {
      name: destination.groupLabel,
      exact: true,
    });
    if ((await trigger.getAttribute('aria-expanded')) !== 'true')
      await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  }

  const links = nav.getByRole('link', { name: destination.label, exact: true });
  let targetIndex = -1;
  for (let index = 0; index < (await links.count()); index += 1) {
    if ((await links.nth(index).getAttribute('href')) === destination.href) {
      targetIndex = index;
      break;
    }
  }
  expect(
    targetIndex,
    `navigation link ${destination.label}`,
  ).toBeGreaterThanOrEqual(0);
  const target = links.nth(targetIndex);
  await expect(target).toBeVisible();
  await expect(
    target,
    `navigation link ${destination.label} is named`,
  ).toHaveAccessibleName(/\S+/);
  await visitPath(page, baseURL, destination.path, async () => {
    await target.click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(new URL(destination.path, baseURL).pathname);
    return null;
  });

  if (destination.path !== sourcePath) {
    await visitPath(page, baseURL, sourcePath, async () => {
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(new URL(sourcePath, baseURL).pathname);
      return null;
    });
  }
}
