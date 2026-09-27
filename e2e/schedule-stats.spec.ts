import { expect, test } from '@playwright/test';
import { builtInSportTemplates } from '@shared/sport/templates';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('staff configures program statistics and opens its leaderboard', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const profile = {
      ...builtInSportTemplates[0],
      stats: [
        {
          key: 'goals',
          label: { en: 'Goals', es: 'Goles' },
          abbreviation: 'G',
          level: 'athlete' as const,
          valueType: 'integer' as const,
          aggregate: 'sum' as const,
          public: true,
        },
        {
          key: 'private_mark',
          label: { en: 'Private mark', es: 'Marca privada' },
          abbreviation: 'PM',
          level: 'athlete' as const,
          valueType: 'decimal' as const,
          aggregate: 'max' as const,
          public: false,
        },
      ],
    };
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .updateTable('sport_profiles')
        .set({ profile })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.sportProfileId)
        .execute();
      await trx
        .updateTable('programs')
        .set({ settings: { statsEnabled: [] } })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
    });
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
    const baseURL = String(testInfo.project.use.baseURL);
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    await page
      .getByRole('textbox', { name: 'Program ID *' })
      .fill(program.programId);
    await page.getByRole('button', { name: 'Load statistic settings' }).click();
    await expect(page.getByLabel('Goals (athlete) · public')).toBeVisible();
    await expect(
      page.getByLabel('Private mark (athlete) · staff only'),
    ).toBeVisible();
    await page.getByLabel('Goals (athlete) · public').check();
    await page.getByRole('button', { name: 'Save statistic settings' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Program statistics settings saved.',
    );
    await page.getByRole('button', { name: 'Load leaderboards' }).click();
    await expect(page.getByText('No finalized results yet.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
