import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('family portal shell navigates between working pages in Spanish', async ({
  page,
}, testInfo) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const actor = await createTestFactories(database).actor();
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: String(testInfo.project.use.baseURL),
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.addInitScript(() => {
      localStorage.setItem('athlentry-language', 'es');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/portal/orgs/${actor.orgId}/notifications`);
    await expect(page.getByText('Portal familiar')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Notificaciones' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Preferencias de entrega' }),
    ).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(
      nav.getByRole('link', { name: 'Notificaciones' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(await accessibilityViolations(page)).toEqual([]);
    await nav.getByRole('link', { name: 'Mensajes' }).click();
    await expect(page).toHaveURL(`/me/orgs/${actor.orgId}/messages`);
    await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Mensajes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await accessibilityViolations(page)).toEqual([]);
    await nav.getByRole('link', { name: 'Cuenta' }).click();
    await expect(page).toHaveURL('/me');
    await expect(
      page.getByRole('heading', { name: /Le damos la bienvenida/ }),
    ).toBeVisible();
  } finally {
    await database.destroy();
  }
});
