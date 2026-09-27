import { randomUUID } from 'node:crypto';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';

import {
  accountRoutes,
  anonymousRoutes,
  ownerRoutes,
  platformRoutes,
} from './catalog';
import { collectPaths, visitPath } from './visit';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const appUrl = `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`;
const adminUrl = `postgres://athlentry_admin@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`;

async function signIn(
  context: BrowserContext,
  baseURL: string,
  databaseUrl: string,
  accountId: string,
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
          privileged: true,
          mfaVerifiedAt: new Date(),
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

async function crawl(
  page: Page,
  baseURL: string,
  seeds: readonly string[],
): Promise<void> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('favicon')) return;
    if (text.includes('Download the React DevTools')) return;
    consoleErrors.push(text);
  });
  const queue = [...seeds];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < 50) {
    const path = queue.shift();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    await visitPath(page, path);
    for (const next of await collectPaths(page, baseURL)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  expect(seen.size, 'crawler should open at least one route').toBeGreaterThan(
    0,
  );
  expect(pageErrors, 'unhandled page errors').toEqual([]);
  expect(consoleErrors, 'console errors').toEqual([]);
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

test('anonymous visitor can open every public auth route', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const baseURL = String(testInfo.project.use.baseURL);
  await crawl(page, baseURL, anonymousRoutes);
});

test('owner can open every mounted console, portal, and account route', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const baseURL = String(testInfo.project.use.baseURL);
  const database = createDatabase(appUrl);
  try {
    const actor = await createTestFactories(database).actor();
    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute(),
    );
    await signIn(page.context(), baseURL, appUrl, actor.accountId);
    await crawl(page, baseURL, ownerRoutes(actor.orgId));
  } finally {
    await database.destroy();
  }
});

test('registrar navigation does not crash on the routes it exposes', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const baseURL = String(testInfo.project.use.baseURL);
  const database = createDatabase(appUrl);
  try {
    const factories = createTestFactories(database);
    const owner = await factories.actor();
    const registrarId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: registrarId,
        email: `registrar-${randomUUID()}@example.invalid`,
        first_name: 'Riley',
        last_name: 'Registrar',
        date_of_birth: '1991-02-02',
        email_verified_at: new Date(),
      })
      .execute();
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: randomUUID(),
          org_id: owner.orgId,
          account_id: registrarId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: randomUUID(),
          org_id: owner.orgId,
          account_id: registrarId,
          role: 'registrar',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
    await signIn(page.context(), baseURL, appUrl, registrarId);
    await crawl(page, baseURL, [
      `/console/orgs/${owner.orgId}`,
      ...accountRoutes(),
    ]);
  } finally {
    await database.destroy();
  }
});

test('guardian account routes render without a generic error', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const baseURL = String(testInfo.project.use.baseURL);
  const database = createDatabase(appUrl);
  try {
    const accountId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `guardian-${randomUUID()}@example.invalid`,
        first_name: 'Gray',
        last_name: 'Guardian',
        date_of_birth: '1988-03-03',
        email_verified_at: new Date(),
      })
      .execute();
    await signIn(page.context(), baseURL, appUrl, accountId);
    await crawl(page, baseURL, accountRoutes());
  } finally {
    await database.destroy();
  }
});

test('platform staff can open platform navigation', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const baseURL = String(testInfo.project.use.baseURL);
  const database = createDatabase(adminUrl);
  try {
    const accountId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `platform-${randomUUID()}@example.invalid`,
        first_name: 'Pat',
        last_name: 'Platform',
        date_of_birth: '1985-04-04',
        email_verified_at: new Date(),
      })
      .execute();
    await database
      .insertInto('platform_staff')
      .values({ account_id: accountId, role: 'super_admin', active: true })
      .execute();
    await signIn(page.context(), baseURL, adminUrl, accountId);
    await crawl(page, baseURL, platformRoutes);
  } finally {
    await database.destroy();
  }
});
