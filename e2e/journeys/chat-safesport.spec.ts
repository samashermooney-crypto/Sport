import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';
import { accessibilityViolations } from '../axe';
import { e2eDatabaseUrl } from '../database';

async function signInBrowser(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  database: ReturnType<typeof createDatabase>,
  accountId: string,
  privileged = false,
) {
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
}

test('team chat includes the minor athlete’s guardian and lets the guardian reply', async ({
  page,
}, testInfo) => {
  const database = createDatabase(e2eDatabaseUrl('app'));
  try {
    const factories = createTestFactories(database);
    const staff = await factories.actor();
    const guardianId = randomUUID();
    const athleteId = randomUUID();
    const athletePersonId = await factories.person(staff, {
      firstName: 'Jordan',
      lastName: 'Reed',
      dateOfBirth: '2014-05-20',
    });
    const program = await factories.program(staff);
    const team = await factories.team(staff, program);

    await database
      .insertInto('accounts')
      .values([
        {
          id: guardianId,
          email: `guardian-${randomUUID()}@example.invalid`,
          first_name: 'Taylor',
          last_name: 'Reed',
          date_of_birth: '1985-02-10',
          email_verified_at: new Date(),
        },
        {
          id: athleteId,
          email: `athlete-${randomUUID()}@example.invalid`,
          first_name: 'Jordan',
          last_name: 'Reed',
          date_of_birth: '2014-05-20',
          email_verified_at: new Date(),
        },
      ])
      .execute();

    const withOrg = createWithOrg(database);
    await withOrg(staff, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', staff.orgId)
        .where('account_id', '=', staff.accountId)
        .execute();
      await trx
        .insertInto('person_account_links')
        .values([
          {
            id: randomUUID(),
            org_id: staff.orgId,
            person_id: athletePersonId,
            account_id: athleteId,
            relationship: 'self',
          },
          {
            id: randomUUID(),
            org_id: staff.orgId,
            person_id: athletePersonId,
            account_id: guardianId,
            relationship: 'guardian',
          },
        ])
        .execute();
      await trx
        .insertInto('roster_entries')
        .values({
          id: randomUUID(),
          org_id: staff.orgId,
          team_season_id: team.teamSeasonId,
          person_id: athletePersonId,
          status: 'active',
        })
        .execute();
    });

    await withOrg(staff, (trx) =>
      trx
        .updateTable('team_seasons')
        .set({ status: 'active' })
        .where('org_id', '=', staff.orgId)
        .where('id', '=', team.teamSeasonId)
        .execute(),
    );
    await withOrg(staff, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', staff.orgId)
        .where('account_id', '=', staff.accountId)
        .execute(),
    );
    await signInBrowser(page, testInfo, database, staff.accountId, true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/me/orgs/${staff.orgId}/messages`);
    await expect(
      page.getByRole('heading', { name: 'Messages', exact: true }),
    ).toBeVisible();
    await page
      .locator('.portal-team-list')
      .first()
      .getByRole('button', { name: /Fixture Team/ })
      .click();

    const teamConversation = page
      .getByRole('listitem')
      .filter({ hasText: 'Guardian included' });
    await expect(teamConversation).toBeVisible();
    await page.getByLabel('Write a message').fill('Practice starts at 6.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Practice starts at 6.')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await signInBrowser(page, testInfo, database, guardianId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/me/orgs/${staff.orgId}/messages`);
    await expect(
      page.getByRole('heading', { name: 'Messages', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Guardian included' })
      .getByRole('button')
      .click();
    await expect(page.getByText('Practice starts at 6.')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.getByLabel('Write a message').fill('Thanks, we will be there.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Thanks, we will be there.')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
