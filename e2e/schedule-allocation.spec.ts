import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

function dateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

test('coach requests an allocated practice slot for scheduler approval', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const team = await factories.team(actor, program);
    const otherTeam = await factories.team(actor, program);
    const coachPersonId = await factories.person(actor, {
      firstName: 'Casey',
      lastName: 'Coach',
      dateOfBirth: '1985-01-01',
    });
    const coachAccountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: coachAccountId,
        email: `coach-${coachAccountId}@example.invalid`,
        first_name: 'Casey',
        last_name: 'Coach',
        date_of_birth: '1985-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await createWithOrg(database)(actor, (trx) =>
      Promise.all([
        trx
          .updateTable('role_assignments')
          .set({ pending_mfa: false })
          .where('org_id', '=', actor.orgId)
          .where('account_id', '=', actor.accountId)
          .execute(),
        trx
          .insertInto('org_memberships')
          .values({
            id: newId(),
            org_id: actor.orgId,
            account_id: coachAccountId,
            status: 'active',
            joined_at: new Date(),
          })
          .execute(),
        trx
          .insertInto('person_account_links')
          .values({
            id: newId(),
            org_id: actor.orgId,
            person_id: coachPersonId,
            account_id: coachAccountId,
            relationship: 'self',
            verified_at: new Date(),
          })
          .execute(),
        trx
          .insertInto('team_staff')
          .values({
            id: newId(),
            org_id: actor.orgId,
            team_season_id: team.teamSeasonId,
            person_id: coachPersonId,
            role: 'head_coach',
            status: 'active',
            added_by: actor.accountId,
          })
          .execute(),
      ]).then(() => undefined),
    );
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

    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    const facilities = page.locator(
      'section[aria-labelledby="schedule-facilities-heading"]',
    );
    const facilityForm = facilities.locator('form').first();
    const facilityResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/facilities'),
    );
    await facilityForm.getByLabel('Facility name *').fill('Practice Park');
    await facilityForm.getByRole('button', { name: 'Add facility' }).click();
    const facilityResponseResult = await facilityResponse;
    expect(facilityResponseResult.ok()).toBe(true);
    const facility = (await facilityResponseResult.json()) as { id: string };
    await expect(page.getByRole('status')).toHaveText('Facility created.');

    const spaceDetails = facilities
      .locator('details')
      .filter({ hasText: 'Add a bookable space' });
    await spaceDetails
      .getByText('Add a bookable space', { exact: true })
      .click();
    const spaceForm = spaceDetails.locator('form');
    const spaceResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/spaces'),
    );
    await spaceForm.getByLabel('Facility *').selectOption(facility.id);
    await spaceForm.getByLabel('Space name *').fill('Team Practice Field');
    await spaceForm.getByLabel('Space type *').selectOption('field');
    await spaceForm.getByRole('button', { name: 'Add space' }).click();
    const spaceResponseResult = await spaceResponse;
    expect(spaceResponseResult.ok()).toBe(true);
    const space = (await spaceResponseResult.json()) as { id: string };
    await expect(page.getByRole('status')).toHaveText(
      'Bookable space created.',
    );

    const startsOn = new Date();
    startsOn.setUTCDate(startsOn.getUTCDate() + 3);
    const endsOn = new Date(startsOn);
    endsOn.setUTCDate(endsOn.getUTCDate() + 35);
    const generator = page.locator(
      'section[aria-labelledby="schedule-generator-heading"]',
    );
    await generator.getByLabel('Program ID *').fill(program.programId);
    const allocationDetails = facilities
      .locator('details')
      .filter({ hasText: 'Allocate recurring practice or game time' });
    await allocationDetails
      .getByText('Allocate recurring practice or game time', { exact: true })
      .click();
    const allocationForm = allocationDetails.locator('form');
    const allocationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/allocations'),
    );
    await allocationForm.getByLabel('Space *').selectOption(space.id);
    await allocationForm.getByLabel('Team season ID').fill(team.teamSeasonId);
    await allocationForm.getByLabel('Weekday *').fill(dateInput(startsOn));
    await allocationForm.getByLabel('Starts on *').fill(dateInput(startsOn));
    await allocationForm.getByLabel('Ends on *').fill(dateInput(endsOn));
    await allocationForm.getByLabel('Start time *').fill('17:00');
    await allocationForm.getByLabel('End time *').fill('18:00');
    await allocationForm
      .getByRole('button', { name: 'Create allocation' })
      .click();
    const allocationResponseResult = await allocationResponse;
    expect(allocationResponseResult.ok()).toBe(true);
    const allocation = (await allocationResponseResult.json()) as {
      id: string;
    };
    await expect(page.getByRole('status')).toHaveText(
      'Recurring allocation created.',
    );

    await facilities
      .getByLabel('Let coaches request allocated practice slots')
      .check();
    await facilities
      .getByRole('button', { name: 'Save slot-picker settings' })
      .click();
    await expect(page.getByRole('status')).toHaveText(
      'Schedule settings saved.',
    );

    const coachSession = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: coachAccountId,
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
        value: coachSession.token,
        url: String(testInfo.project.use.baseURL),
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.goto(
      `/portal/orgs/${actor.orgId}/schedule/teams/${team.teamSeasonId}/practice-slots`,
    );
    await expect(
      page.getByRole('heading', { name: 'Request an allocated practice slot' }),
    ).toBeVisible();
    const otherTeamAccess = await page.evaluate(
      async ({ orgId, teamSeasonId }) =>
        fetch(
          `/api/v1/scheduling/orgs/${orgId}/team-seasons/${teamSeasonId}/practice-allocations`,
          { credentials: 'include' },
        ).then((response) => response.status),
      { orgId: actor.orgId, teamSeasonId: otherTeam.teamSeasonId },
    );
    expect(otherTeamAccess).toBe(403);
    const slotForm = page
      .locator('form')
      .filter({ hasText: 'Request this slot' });
    await slotForm
      .getByLabel('Available practice slot')
      .selectOption({ index: 1 });
    const requestResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/allocations/${allocation.id}/requests`),
    );
    await slotForm.getByRole('button', { name: 'Request this slot' }).click();
    const requestResponseResult = await requestResponse;
    expect(requestResponseResult.ok()).toBe(true);
    const request = (await requestResponseResult.json()) as {
      id: string;
      status: string;
    };
    expect(request.status).toBe('pending');
    await expect(page.getByRole('status')).toHaveText(
      'Your practice slot request is waiting for scheduler approval.',
    );
    expect(await accessibilityViolations(page)).toEqual([]);

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
    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    const requests = page.locator(
      'section[aria-labelledby="schedule-requests-heading"]',
    );
    await requests.getByRole('button', { name: 'Refresh requests' }).click();
    const requestCard = requests
      .locator('article')
      .filter({ hasText: team.teamSeasonId.slice(0, 8) });
    await expect(requestCard).toBeVisible();
    const approvalResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/allocation-requests/${request.id}/decision`),
    );
    await requestCard.getByRole('button', { name: 'Approve slot' }).click();
    const approvalResponseResult = await approvalResponse;
    expect(approvalResponseResult.ok()).toBe(true);
    expect(
      ((await approvalResponseResult.json()) as { status: string }).status,
    ).toBe('approved');

    const decidedRequest = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('allocation_requests')
        .select(['status', 'resulting_event_id'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', request.id)
        .executeTakeFirstOrThrow(),
    );
    expect(decidedRequest.status).toBe('approved');
    expect(decidedRequest.resulting_event_id).toBeTruthy();
    const event = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['kind', 'published', 'space_id'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', decidedRequest.resulting_event_id ?? '')
        .executeTakeFirstOrThrow(),
    );
    expect(event).toEqual({
      kind: 'practice',
      published: false,
      space_id: space.id,
    });
  } finally {
    await database.destroy();
  }
});
