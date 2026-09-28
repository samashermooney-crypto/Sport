import { randomUUID } from 'node:crypto';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';

import {
  anonymousEntryRoutes,
  familyEntryRoutes,
  organizationEntryRoutes,
  organizationRoles,
  platformEntryRoutes,
  platformRoles,
} from './catalog';
import {
  clickNavigationButtons,
  clickNavigationDestination,
  collectPaths,
  visitPath,
} from './visit';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const appUrl = `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`;
const adminUrl = `postgres://athlentry_admin@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`;
const publicSiteOrgId = '33333333-3333-4333-8333-333333333333';

type RouteActor = { accountId: string; orgId: string };
type FamilyRelationship = 'guardian' | 'self';

async function signIn(
  context: BrowserContext,
  baseURL: string,
  databaseUrl: string,
  accountId: string,
  privileged: boolean,
): Promise<void> {
  const database = createDatabase(databaseUrl);
  try {
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId,
          kind: 'cookie',
          client: 'web',
          privileged,
          ...(privileged ? { mfaVerifiedAt: new Date() } : {}),
        },
        new Date(),
      ),
    );
    await context.addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  } finally {
    await database.destroy();
  }
}

async function createOrganizationRoleActor(
  databaseUrl: string,
  role: (typeof organizationRoles)[number],
): Promise<RouteActor> {
  const database = createDatabase(databaseUrl);
  try {
    const owner = await createTestFactories(database).actor();
    if (role === 'owner') {
      await createWithOrg(database)(owner, (trx) =>
        trx
          .updateTable('role_assignments')
          .set({ pending_mfa: false })
          .where('org_id', '=', owner.orgId)
          .where('account_id', '=', owner.accountId)
          .execute(),
      );
      return { accountId: owner.accountId, orgId: owner.orgId };
    }

    const accountId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `crawler-${role}-${randomUUID()}@example.invalid`,
        first_name: 'Route',
        last_name: 'Crawler',
        date_of_birth: '1990-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: randomUUID(),
          org_id: owner.orgId,
          account_id: accountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: randomUUID(),
          org_id: owner.orgId,
          account_id: accountId,
          role,
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
    return { accountId, orgId: owner.orgId };
  } finally {
    await database.destroy();
  }
}

async function createFamilyActor(
  databaseUrl: string,
  relationship: FamilyRelationship,
): Promise<RouteActor> {
  const database = createDatabase(databaseUrl);
  try {
    const factories = createTestFactories(database);
    const owner = await factories.actor();
    const personId = await factories.person(owner, {
      firstName: 'Route',
      lastName: relationship === 'guardian' ? 'Guardian' : 'Self',
    });
    const accountId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `crawler-${relationship}-${randomUUID()}@example.invalid`,
        first_name: 'Route',
        last_name: relationship === 'guardian' ? 'Guardian' : 'Self',
        date_of_birth:
          relationship === 'guardian' ? '1988-03-03' : '2010-03-03',
        email_verified_at: new Date(),
      })
      .execute();
    await createWithOrg(database)(owner, (trx) =>
      trx
        .insertInto('person_account_links')
        .values({
          id: randomUUID(),
          org_id: owner.orgId,
          person_id: personId,
          account_id: accountId,
          relationship,
          verified_at: new Date(),
        })
        .execute(),
    );
    return { accountId, orgId: owner.orgId };
  } finally {
    await database.destroy();
  }
}

async function createPlatformActor(
  databaseUrl: string,
  role: (typeof platformRoles)[number]['databaseRole'],
): Promise<string> {
  const database = createDatabase(databaseUrl);
  try {
    const accountId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `crawler-platform-${role}-${randomUUID()}@example.invalid`,
        first_name: 'Platform',
        last_name: 'Crawler',
        date_of_birth: '1985-04-04',
        email_verified_at: new Date(),
      })
      .execute();
    await database
      .insertInto('platform_staff')
      .values({ account_id: accountId, role, active: true })
      .execute();
    return accountId;
  } finally {
    await database.destroy();
  }
}

async function crawlNavigation(
  page: Page,
  baseURL: string,
  seeds: readonly string[],
): Promise<void> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(`${new URL(page.url()).pathname}: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push(`${new URL(page.url()).pathname}: ${message.text()}`);
  });
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (event) => {
      console.error(`unhandledrejection: ${String(event.reason)}`);
    });
  });

  const visited = new Set<string>();
  const clickedDestinations = new Set<string>();
  const discovered = new Set(seeds);
  const queue = [...seeds];
  let globalSearchExercised = false;
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    await visitPath(page, baseURL, path);
    if (!globalSearchExercised)
      globalSearchExercised = await exerciseGlobalSearch(page);
    const links = await collectPaths(page, baseURL);
    await clickNavigationButtons(page, baseURL, path);
    for (const link of links) {
      discovered.add(link.path);
      const identity = [
        link.navigationIndex,
        link.groupLabel ?? '',
        link.href,
        link.label,
      ].join('\u0000');
      if (!clickedDestinations.has(identity)) {
        await clickNavigationDestination(page, baseURL, path, link);
        clickedDestinations.add(identity);
      }
      if (!visited.has(link.path) && !queue.includes(link.path))
        queue.push(link.path);
    }
  }

  expect(
    [...discovered].filter((path) => !visited.has(path)),
    'every route found in a rendered navigation should be visited',
  ).toEqual([]);
  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(
    consoleErrors,
    'console errors and unhandled promise rejections',
  ).toEqual([]);
}

async function exerciseGlobalSearch(page: Page): Promise<boolean> {
  const button = page.locator('.ui-global-search:visible');
  if (!(await button.count())) return false;
  await expect(button).toHaveAccessibleName(/\S+/);
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).not.toBeVisible();
  return true;
}

async function mockPublicSiteData(page: Page): Promise<void> {
  await page.route(
    /\/api\/v1\/sponsors\/public\/orgs\/qa-crawler\/sponsors(?:\?|$)/,
    (route) =>
      route.fulfill({
        json: {
          sponsors: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              name: 'QA Crawler Sponsor',
              tier: 'Community',
              websiteUrl: null,
              logoFileId: null,
            },
          ],
        },
      }),
  );
  await page.route(
    /\/api\/v1\/fundraising\/public\/orgs\/qa-crawler\/campaigns\/qa-campaign(?:\?|$)/,
    (route) =>
      route.fulfill({
        json: {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'QA Crawler Fundraiser',
          slug: 'qa-campaign',
          goalCents: 100_000,
          startsAt: '2026-09-01T00:00:00.000Z',
          endsAt: null,
          teamSeasonId: null,
          descriptionHtml: '<p>Supporting local youth athletes.</p>',
          status: 'published',
          totalRaisedCents: 25_000,
          donorCount: 2,
          version: 1,
          orgId: publicSiteOrgId,
          donorWall: [],
        },
      }),
  );
}

test.beforeEach(async ({ request }) => {
  await expect
    .poll(async () => {
      try {
        return (await request.get('/healthz')).status();
      } catch {
        return 0;
      }
    })
    .toBe(200);
});

test('anonymous navigation routes render without errors', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await mockPublicSiteData(page);
  await crawlNavigation(
    page,
    String(testInfo.project.use.baseURL),
    anonymousEntryRoutes,
  );
});

for (const role of organizationRoles) {
  test(`organization navigation renders for ${role}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const baseURL = String(testInfo.project.use.baseURL);
    const actor = await createOrganizationRoleActor(appUrl, role);
    await signIn(page.context(), baseURL, appUrl, actor.accountId, true);
    await crawlNavigation(page, baseURL, organizationEntryRoutes(actor.orgId));
  });
}

for (const relationship of ['guardian', 'self'] as const) {
  test(`family navigation renders for ${relationship} accounts`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const baseURL = String(testInfo.project.use.baseURL);
    const actor = await createFamilyActor(appUrl, relationship);
    await signIn(page.context(), baseURL, appUrl, actor.accountId, false);
    await crawlNavigation(page, baseURL, familyEntryRoutes(actor.orgId));
  });
}

for (const role of platformRoles) {
  test(`platform navigation renders for ${role.name}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const baseURL = String(testInfo.project.use.baseURL);
    const accountId = await createPlatformActor(adminUrl, role.databaseRole);
    await signIn(page.context(), baseURL, adminUrl, accountId, true);
    await crawlNavigation(page, baseURL, platformEntryRoutes);
  });
}
