import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('owner creates, edits and archives a person from the console', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
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
    await page.goto(`/console/orgs/${actor.orgId}`);
    await page.getByRole('link', { name: 'Manage people' }).click();
    await expect(
      page.getByRole('heading', { name: 'People', exact: true }),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'First name' }).fill('Alex');
    await page.getByRole('textbox', { name: 'Last name' }).fill('Rivera');
    await page.getByLabel('Date of birth').fill('2011-04-12');
    await page.getByRole('button', { name: 'Create person' }).click();
    await expect(
      page.getByRole('heading', { name: 'Alex Rivera' }),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Preferred name' }).fill('Lex');
    const savedPerson = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/api/v1/people/orgs/${actor.orgId}/`),
    );
    await page.getByRole('button', { name: 'Save person' }).click();
    expect((await savedPerson).ok()).toBe(true);
    await expect(
      page.getByRole('button', { name: 'Save person' }),
    ).toBeEnabled();
    await expect(
      page.getByRole('textbox', { name: 'Preferred name' }),
    ).toHaveValue('Lex');
    const personId = page.url().split('/').at(-1) ?? '';
    const credentialTypeId = newId();
    await factories.row(actor, 'credential_types', {
      id: credentialTypeId,
      org_id: actor.orgId,
      key: `e2e_coach_${newId().replaceAll('-', '_')}`,
      name: 'Head coach safety training',
      verification: 'manual_staff',
      validity: {},
      applies_to: { roles: ['head_coach'], minimumAge: 18 },
      active: true,
    });
    await factories.row(actor, 'role_credential_requirements', {
      id: newId(),
      org_id: actor.orgId,
      role: 'head_coach',
      credential_type_id: credentialTypeId,
      scope_type: 'org',
      scope_id: null,
      minimum_age: 18,
    });
    await expect(
      page.getByText(
        'Grant media consent in this profile before adding a photo.',
      ),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Media consent' })
      .selectOption('granted');
    const consentSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response
          .url()
          .includes(`/api/v1/people/orgs/${actor.orgId}/${personId}`),
    );
    await page.getByRole('button', { name: 'Save person' }).click();
    expect((await consentSaved).ok()).toBe(true);
    await expect(page.getByLabel('Choose photo')).toBeVisible();
    await page
      .getByLabel('Choose photo')
      .setInputFiles('server/test/fixtures/gps-photo.jpg');
    const photoSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith(`/api/v1/people/orgs/${actor.orgId}/${personId}/photo`),
    );
    await page.getByRole('button', { name: 'Crop and upload photo' }).click();
    expect((await photoSaved).ok()).toBe(true);
    await expect(page.getByRole('img', { name: 'Alex Rivera' })).toBeVisible({
      timeout: 15_000,
    });
    await page
      .getByRole('combobox', { name: 'Media consent' })
      .selectOption('denied');
    const consentRevoked = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response
          .url()
          .includes(`/api/v1/people/orgs/${actor.orgId}/${personId}`),
    );
    await page.getByRole('button', { name: 'Save person' }).click();
    expect((await consentRevoked).ok()).toBe(true);
    await expect(page.getByRole('img', { name: 'Alex Rivera' })).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
    const archivedPerson = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith(`/people/orgs/${actor.orgId}/${personId}/archive`),
    );
    await page.getByRole('button', { name: 'Archive person' }).click();
    const archiveConfirmation = page.getByRole('dialog', {
      name: 'Archive this person?',
    });
    await expect(archiveConfirmation).toBeVisible();
    await archiveConfirmation
      .getByRole('button', { name: 'Archive person' })
      .click();
    expect((await archivedPerson).ok()).toBe(true);
    await expect(page).toHaveURL(`/console/orgs/${actor.orgId}/people`);
    await expect(
      page.getByText('No active people match this search.'),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Status', exact: true })
      .selectOption('archived');
    await expect(page.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    await page.getByRole('link', { name: 'Alex Rivera' }).click();
    await page.getByRole('button', { name: 'Restore person' }).click();
    await expect(
      page.getByRole('button', { name: 'Save person' }),
    ).toBeVisible();
    await page.goto(`/console/orgs/${actor.orgId}/households`);
    await page
      .getByRole('textbox', { name: 'Household name' })
      .fill('Rivera household');
    await page.getByRole('button', { name: 'Create household' }).click();
    await expect(
      page.getByRole('heading', { name: 'Rivera household' }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Person' })
      .selectOption({ label: 'Alex Rivera' });
    await page.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    const householdUrl = page.url();
    const fixture = await factories.program(actor);
    const team = await factories.team(actor, fixture);
    const registrationId = await factories.registration(
      actor,
      fixture,
      personId,
      householdUrl.split('/').at(-1) ?? '',
    );
    await factories.row(actor, 'roster_entries', {
      id: newId(),
      org_id: actor.orgId,
      team_season_id: team.teamSeasonId,
      person_id: personId,
      registration_id: registrationId,
    });
    await page.goto(`/console/orgs/${actor.orgId}/people`);
    const commandPalette = page.getByRole('dialog', {
      name: 'Command palette',
    });
    await page.getByRole('button', { name: 'Search Athlentry' }).click();
    const globalSearch = commandPalette.getByRole('searchbox', {
      name: 'Search Athlentry',
    });
    await globalSearch.fill('Rivera household');
    const householdSearchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes(`/people/households/orgs/${actor.orgId}`),
    );
    await globalSearch.press('Enter');
    expect((await householdSearchResponse).ok()).toBe(true);
    await commandPalette
      .getByRole('link', { name: 'Rivera household' })
      .click();
    await expect(page).toHaveURL(householdUrl);
    await expect(
      page.getByRole('heading', { name: 'Rivera household' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Search Athlentry' }).click();
    const peopleSearch = commandPalette.getByRole('searchbox', {
      name: 'Search Athlentry',
    });
    await peopleSearch.fill('Alex Rivera');
    const peopleSearchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes(`/people/orgs/${actor.orgId}?`),
    );
    await peopleSearch.press('Enter');
    expect((await peopleSearchResponse).ok()).toBe(true);
    await commandPalette.getByRole('link', { name: 'Alex Rivera' }).click();
    await expect(page).toHaveURL(
      `/console/orgs/${actor.orgId}/people/${personId}`,
    );
    await expect(
      page.getByRole('heading', { name: 'Alex Rivera' }),
    ).toBeVisible();

    await page.goto(`/console/orgs/${actor.orgId}/people`);
    await page
      .getByRole('searchbox', { name: 'Find household' })
      .fill('Rivera');
    await page
      .getByRole('combobox', { name: 'Household' })
      .selectOption({ label: 'Rivera household' });
    await expect(page.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Balance' }).selectOption('true');
    await expect(page.getByText(/No active people match/)).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Balance' }).selectOption('');
    await page.getByRole('searchbox', { name: 'Find program' }).fill('Fixture');
    await page
      .getByRole('combobox', { name: 'Program' })
      .selectOption({ label: 'Fixture League' });
    await page.getByRole('searchbox', { name: 'Find team' }).fill('Fixture');
    await page
      .getByRole('combobox', { name: 'Team' })
      .selectOption({ label: 'Fixture Team — Fixture League' });
    await expect(page.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Compliance credential status' })
      .selectOption('none');
    await expect(page.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Compliance credential status' })
      .selectOption('pending_review');
    await expect(page.getByText(/No active people match/)).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Compliance credential status' })
      .selectOption('');
    await page
      .getByRole('combobox', { name: 'Review role eligibility' })
      .selectOption('head_coach');
    await expect(page.getByText(/Head coach: Needs review/)).toBeVisible();
    await expect(page.getByText(/at least 18 years old/)).toBeVisible();
    await expect(
      page.getByText('Required credential has not been submitted.'),
    ).toBeVisible();
    await page.goto(householdUrl);
    await expect(
      page.getByRole('heading', { name: 'Rivera household' }),
    ).toBeVisible();
    await page.getByText('Edit Alex Rivera').click();
    const memberEditor = page
      .locator('details')
      .filter({ hasText: 'Edit Alex Rivera' });
    await memberEditor.getByRole('checkbox', { name: 'Can pick up' }).check();
    const savedMember = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes('/members/'),
    );
    const refreshedMember = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/people/households/orgs/') &&
        response.url().endsWith(page.url().split('/').at(-1) ?? ''),
    );
    await page.getByRole('button', { name: 'Save member' }).click();
    expect((await savedMember).ok()).toBe(true);
    await refreshedMember;
    await page.getByText('Edit Alex Rivera').click();
    await expect(
      memberEditor.getByRole('checkbox', { name: 'Can pick up' }),
    ).toBeChecked();
    await memberEditor.getByRole('button', { name: 'Remove member' }).click();
    const removeConfirmation = page.getByRole('dialog', {
      name: 'Remove this household member?',
    });
    await expect(removeConfirmation).toBeVisible();
    await removeConfirmation
      .getByRole('button', { name: 'Remove member' })
      .click();
    await expect(page.getByText('No members yet')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
