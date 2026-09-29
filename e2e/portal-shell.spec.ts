import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';
import { e2eDatabaseUrl } from './database';


test('family portal shell navigates between working pages in Spanish', async ({
  page,
}, testInfo) => {
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  try {
    const actor = await createTestFactories(database).actor();
    await database
      .updateTable('accounts')
      .set({ locale: 'es' })
      .where('id', '=', actor.accountId)
      .execute();
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
      localStorage.setItem('athlentry-language', 'en');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const accountLocale = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/me'),
    );
    await page.goto(`/portal/orgs/${actor.orgId}/notifications`);
    const accountResponse = await accountLocale;
    expect(accountResponse.status()).toBe(200);
    expect(await accountResponse.json()).toMatchObject({ locale: 'es' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByText('Portal familiar')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Notificaciones' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Preferencias de entrega' }),
    ).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Navegación móvil' });
    await expect(
      nav.getByRole('link', { name: 'Notificaciones' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(await accessibilityViolations(page)).toEqual([]);
    await nav.getByRole('link', { name: 'Mensajes' }).click();
    await expect(page).toHaveURL(`/me/orgs/${actor.orgId}/messages`);
    await expect(
      page.getByRole('heading', { name: 'Mensajes', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Conversaciones' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Consentimiento para mensajes de texto',
      }),
    ).toBeVisible();
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
    await page.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    await expect
      .poll(async () =>
        database
          .selectFrom('accounts')
          .select('locale')
          .where('id', '=', actor.accountId)
          .executeTakeFirstOrThrow()
          .then((account) => account.locale),
      )
      .toBe('en');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await expect(
      page.getByRole('heading', { name: /Le damos la bienvenida/ }),
    ).toBeVisible();
  } finally {
    await database.destroy();
  }
});
