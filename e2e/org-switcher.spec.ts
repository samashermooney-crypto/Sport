import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';
import { newId } from '../shared/src/ids';

import { accessibilityViolations } from './axe';
import { e2eDatabaseUrl } from './database';


test('switches between active organizations and only renders authorized actions', async ({
  page,
}, testInfo) => {
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  try {
    const factory = createTestFactories(database);
    const owner = await factory.actor();
    const other = await factory.actor();
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', owner.orgId)
        .where('account_id', '=', owner.accountId)
        .execute();
    });
    await createWithOrg(database)(other, async (trx) => {
      await trx
        .updateTable('organizations')
        .set({ name: 'Other Club' })
        .where('id', '=', other.orgId)
        .execute();
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: other.orgId,
          account_id: owner.accountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
    });
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: owner.accountId,
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
    await page.goto(`/console/orgs/${owner.orgId}`);
    await expect(
      page.getByRole('link', { name: 'Manage staff and invitations' }),
    ).toBeVisible();
    const switcher = page.getByRole('combobox', {
      name: 'Switch organization',
    });
    await expect(switcher).toBeVisible();
    await switcher.selectOption(other.orgId);
    await expect(page).toHaveURL(new RegExp(`/console/orgs/${other.orgId}$`));
    await expect(
      page.getByRole('heading', { name: 'Other Club' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Manage staff and invitations' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Open account security' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
