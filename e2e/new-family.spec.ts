import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';
import { e2eDatabaseUrl } from './database';

test('a new family adds two children on a phone and puts both in the cart', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const database = createDatabase(e2eDatabaseUrl('app'));
  try {
    const factories = createTestFactories(database);
    const staff = await factories.actor();
    const program = await factories.program(staff);
    await createWithOrg(database)(staff, async (trx) => {
      await trx
        .updateTable('programs')
        .set({
          status: 'registration_open',
          visibility: 'public',
          eligibility: { minAge: 6, maxAge: 14 },
        })
        .where('org_id', '=', staff.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('registration_offerings')
        .set({ active: true, visibility: 'public', requires_approval: false })
        .where('org_id', '=', staff.orgId)
        .where('id', '=', program.offeringId)
        .execute();
    });
    // A parent who has never been linked to anyone in this organization.
    const parentId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: parentId,
        email: `new-family-${parentId}@example.invalid`,
        first_name: 'Rosa',
        last_name: 'Ortega',
        date_of_birth: '1987-03-14',
        email_verified_at: new Date(),
      })
      .execute();
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: parentId,
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/portal/orgs/${staff.orgId}/register`);
    await expect(
      page.getByRole('heading', { name: 'Add your child to get started' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    for (const child of [
      { first: 'Mateo', dob: '2016-05-10' },
      { first: 'Lucia', dob: '2018-09-01' },
    ]) {
      await page.getByLabel('First name').fill(child.first);
      await page.getByLabel('Last name').fill('Ortega');
      await page.getByLabel('Date of birth').fill(child.dob);
      await page.getByRole('button', { name: 'Add child' }).click();
      await expect(
        page.getByText(`${child.first} Ortega was added to your family.`),
      ).toBeVisible();
    }
    await expect(
      page.getByRole('heading', { name: 'Add another child' }),
    ).toBeVisible();

    const participantPicker = page.getByLabel('Participant');
    for (const name of ['Mateo Ortega', 'Lucia Ortega']) {
      await participantPicker.selectOption({ label: name });
      await page.getByRole('button', { name: 'Add to cart' }).click();
    }
    const cart = page.locator('[aria-labelledby="cart-title"]');
    await expect(cart.getByText('Mateo Ortega')).toBeVisible();
    await expect(cart.getByText('Lucia Ortega')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    const links = await createWithOrg(database)(
      { orgId: staff.orgId, actor: { accountId: parentId } },
      (trx) =>
        trx
          .selectFrom('person_account_links')
          .select('relationship')
          .where('org_id', '=', staff.orgId)
          .where('account_id', '=', parentId)
          .execute(),
    );
    expect(links.map((link) => link.relationship).sort()).toEqual([
      'guardian',
      'guardian',
      'self',
    ]);
  } finally {
    await database.destroy();
  }
});
