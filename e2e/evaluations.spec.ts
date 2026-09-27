import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe';

const orgId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const participantId = '33333333-3333-4333-8333-333333333333';
const personId = '44444444-4444-4444-8444-444444444444';
const criterionId = '55555555-5555-4555-8555-555555555555';
const programId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const divisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const boardId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const blueTeamId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const goldTeamId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const groupId = '89898989-8989-4898-8898-898989898989';
const alexId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const jordanId = '99999999-9999-4999-8999-999999999999';
const offerId = 'abababab-abab-4bab-8bab-abababababab';
const checkoutId = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
const tryoutRegistrationId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';

async function mockAuthenticatedAccount(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        id: '66666666-6666-4666-8666-666666666666',
        email: 'evaluator@example.test',
        firstName: 'Eval',
        lastName: 'Coach',
        locale: 'en',
        mfaEnabled: false,
        sessionId: '77777777-7777-4777-8777-777777777777',
        client: 'web',
      },
    }),
  );
}

test('evaluator saves offline and syncs each score once after reconnect', async ({
  page,
}) => {
  const savedScores: Array<Record<string, unknown>> = [];
  const scoreRequests: Array<Record<string, unknown>> = [];

  await mockAuthenticatedAccount(page);
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/events/${eventId}/scoring-sheet`,
    (route) =>
      route.fulfill({
        json: {
          event: {
            id: eventId,
            name: 'U10 tryout',
            normalization: 'z_score_per_evaluator',
            status: 'live',
          },
          participants: [
            {
              id: participantId,
              personId,
              bibNumber: 14,
              groupId: '88888888-8888-4888-8888-888888888888',
              groupName: 'U10',
              positionKeys: ['keeper'],
              checkInStatus: 'checked_in',
              firstName: 'Alex',
              lastName: 'Athlete',
              photoFileId: null,
            },
          ],
          criteria: [
            {
              id: criterionId,
              key: 'footwork',
              label: 'Footwork',
              weight: 1,
              scaleMin: 1,
              scaleMax: 5,
              positionSpecific: false,
              positionKeys: [],
            },
          ],
          scores: savedScores,
        },
      }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/events/${eventId}/scores`,
    async (route) => {
      const score = route.request().postDataJSON() as Record<string, unknown>;
      scoreRequests.push(score);
      savedScores.push({
        participantId: score.participantId,
        criterionId: score.criterionId,
        score: score.score,
        notes: score.notes,
        clientMutationId: score.clientMutationId,
        version: 1,
      });
      await route.fulfill({
        json: {
          id: '99999999-9999-4999-8999-999999999999',
          participantId: score.participantId,
          criterionId: score.criterionId,
          version: 1,
          clientMutationId: score.clientMutationId,
        },
      });
    },
  );

  await page.goto(`/portal/orgs/${orgId}/evaluations/${eventId}/score`);
  await expect(page.getByRole('heading', { name: 'U10 tryout' })).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  await page.context().setOffline(true);
  await expect(page.getByText('Offline')).toBeVisible();
  const score = page.getByRole('slider', { name: 'Footwork' });
  await score.focus();
  await score.press('ArrowRight');
  await expect(page.getByText('1 unsynced scores')).toBeVisible();
  expect(scoreRequests).toHaveLength(0);

  await page.context().setOffline(false);
  await expect(page.getByText('0 unsynced scores')).toBeVisible();
  await expect.poll(() => scoreRequests.length).toBe(1);
  expect(scoreRequests[0]?.clientMutationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await page.waitForTimeout(100);
  expect(scoreRequests).toHaveLength(1);
});

test('director moves a rec player with drag/drop or keyboard controls', async ({
  page,
}, testInfo) => {
  const moves: Array<Record<string, unknown>> = [];
  const ratings: Array<Record<string, unknown>> = [];
  await mockAuthenticatedAccount(page);
  await page.route(`**/api/v1/orgs/${orgId}/workspace`, (route) =>
    route.fulfill({ json: { name: 'North Club' } }),
  );
  await page.route(`**/api/v1/evaluations/orgs/${orgId}/programs`, (route) =>
    route.fulfill({
      json: [
        {
          id: programId,
          name: 'U10 League',
          mode: 'league',
          sportProfileId: '12121212-1212-4121-8121-121212121212',
          sportProfileName: 'Soccer',
          rubric: [],
          divisions: [{ id: divisionId, name: 'U10' }],
          offerings: [],
        },
      ],
    }),
  );
  await page.route(`**/api/v1/evaluations/orgs/${orgId}/events`, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/programs/${programId}/placement-preferences`,
    (route) =>
      route.fulfill({
        json: [
          {
            personId: alexId,
            firstName: 'Alex',
            lastName: 'Athlete',
            friendRequestPersonId: null,
            practiceLocation: null,
            coachRating: null,
            note: null,
            source: 'staff',
            version: 1,
          },
          {
            personId: jordanId,
            firstName: 'Jordan',
            lastName: 'Player',
            friendRequestPersonId: null,
            practiceLocation: null,
            coachRating: null,
            note: null,
            source: 'staff',
            version: 1,
          },
        ],
      }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/programs/${programId}/placement-preferences`,
    async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      ratings.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { id: alexId, status: 'draft' } });
    },
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/programs/${programId}/boards`,
    (route) =>
      route.fulfill({
        json: {
          id: boardId,
          targetProgramId: programId,
          divisionId,
          seed: 1,
          assignments: {},
          metrics: [],
          objective: 0,
        },
      }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/boards/${boardId}`,
    (route) =>
      route.fulfill({
        json: {
          id: boardId,
          status: 'draft',
          metrics: [],
          placements: [
            {
              id: '10101010-1010-4010-8010-101010101010',
              personId: alexId,
              firstName: 'Alex',
              lastName: 'Athlete',
              teamSeasonId: blueTeamId,
              teamName: 'Blue',
              rating: 4,
              locked: false,
              status: 'placed',
              version: 3,
            },
            {
              id: '20202020-2020-4020-8020-202020202020',
              personId: jordanId,
              firstName: 'Jordan',
              lastName: 'Player',
              teamSeasonId: goldTeamId,
              teamName: 'Gold',
              rating: 3,
              locked: false,
              status: 'placed',
              version: 5,
            },
          ],
        },
      }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/boards/${boardId}/offers`,
    (route) =>
      route.fulfill({
        json: {
          boardId,
          status: 'draft',
          teams: [
            {
              teamSeasonId: blueTeamId,
              teamName: 'Blue',
              rosterLimit: 12,
              sent: 0,
              accepted: 0,
              declined: 0,
              expired: 0,
              withdrawn: 0,
              placed: 1,
            },
            {
              teamSeasonId: goldTeamId,
              teamName: 'Gold',
              rosterLimit: 12,
              sent: 0,
              accepted: 0,
              declined: 0,
              expired: 0,
              withdrawn: 0,
              placed: 1,
            },
          ],
          nextInLine: [],
        },
      }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/boards/${boardId}/placements/move`,
    async (route) => {
      moves.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { id: alexId, status: 'draft' } });
    },
  );

  await page.goto(`/console/orgs/${orgId}/evaluations`);
  await page.getByLabel('League program').selectOption(programId);
  const alexRating = page.getByRole('group', {
    name: 'Prior-season rating for Alex Athlete',
  });
  await expect(alexRating).toBeVisible();
  await alexRating.getByLabel('Coach rating for Alex Athlete').fill('5');
  await alexRating.getByRole('button', { name: 'Save rating' }).click();
  await expect.poll(() => ratings.length).toBe(1);
  expect(ratings[0]).toMatchObject({
    personId: alexId,
    coachRating: 5,
    source: 'staff',
  });
  await page.getByLabel('Division').selectOption(divisionId);
  await page.getByRole('button', { name: 'Build rec-league board' }).click();
  const alex = page.getByText('Alex Athlete → Blue');
  const jordan = page.getByText('Jordan Player → Gold');
  await expect(alex).toBeVisible();
  await expect(jordan).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  if (testInfo.project.name === 'webkit-mobile') {
    const alexRow = alex.locator('..');
    await alexRow
      .getByLabel('Move Alex Athlete to team')
      .selectOption(goldTeamId);
    await alexRow.getByRole('button', { name: 'Move' }).click();
  } else {
    await alex.dragTo(jordan);
  }
  await expect.poll(() => moves.length).toBe(1);
  expect(moves[0]).toEqual({
    personId: alexId,
    teamSeasonId: goldTeamId,
    expectedVersion: 3,
  });
});

test('tryout director scans a registration and builds a placement board', async ({
  page,
}) => {
  let checkInStatus = 'expected';
  const checkIns: Array<Record<string, unknown>> = [];
  const boardRequests: Array<Record<string, unknown>> = [];
  const rankedPlayers = [
    {
      participantId,
      group: 'U10',
      firstName: 'Alex',
      lastName: 'Athlete',
      composite: 4.5,
      rankInGroup: 1,
      evaluatorCount: 2,
      missingCriteria: [],
    },
    {
      participantId: jordanId,
      group: 'U10',
      firstName: 'Jordan',
      lastName: 'Player',
      composite: 4,
      rankInGroup: 2,
      evaluatorCount: 2,
      missingCriteria: [],
    },
  ];

  await mockAuthenticatedAccount(page);
  await page.route(`**/api/v1/orgs/${orgId}/workspace`, (route) =>
    route.fulfill({ json: { name: 'North Club' } }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/events/${eventId}/setup`,
    (route) =>
      route.fulfill({
        json: {
          canManagePhotos: false,
          event: {
            id: eventId,
            name: 'U10 soccer tryout',
            status: 'live',
            normalization: 'z_score_per_evaluator',
            tryout_program_id: '12121212-1212-4121-8121-121212121212',
            target_program_id: programId,
          },
          groups: [
            {
              id: groupId,
              name: 'U10',
              ageMinMonths: 108,
              ageMaxMonths: 131,
              gender: 'open',
              positionKeys: [],
            },
          ],
          sessions: [],
          participants: [
            {
              id: participantId,
              personId,
              registrationId: tryoutRegistrationId,
              groupId,
              groupName: 'U10',
              sessionId: null,
              bibNumber: 14,
              checkInStatus,
              firstName: 'Alex',
              lastName: 'Athlete',
              mediaConsent: false,
              personVersion: 1,
            },
          ],
        },
      }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/events/${eventId}/registrants`,
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/evaluator-candidates`,
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(`**/api/v1/evaluations/orgs/${orgId}/programs`, (route) =>
    route.fulfill({
      json: [
        {
          id: programId,
          name: 'U10 Competitive',
          mode: 'club',
          sportProfileId: '12121212-1212-4121-8121-121212121212',
          sportProfileName: 'Soccer',
          rubric: [],
          divisions: [{ id: divisionId, name: 'U10' }],
          offerings: [],
        },
      ],
    }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/participants/${participantId}/check-in`,
    async (route) => {
      checkIns.push(route.request().postDataJSON() as Record<string, unknown>);
      checkInStatus = 'checked_in';
      await route.fulfill({
        json: { id: participantId, status: checkInStatus },
      });
    },
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/events/${eventId}/compute-results`,
    (route) => route.fulfill({ json: rankedPlayers }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/events/${eventId}/results`,
    (route) => route.fulfill({ json: rankedPlayers }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/events/${eventId}/boards`,
    async (route) => {
      boardRequests.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      await route.fulfill({
        json: {
          id: boardId,
          targetProgramId: programId,
          divisionId,
          seed: 1,
          assignments: { [alexId]: blueTeamId, [jordanId]: goldTeamId },
          metrics: [],
          objective: 0,
        },
      });
    },
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/boards/${boardId}`,
    (route) =>
      route.fulfill({
        json: {
          id: boardId,
          status: 'draft',
          metrics: [],
          placements: [
            {
              id: '10101010-1010-4010-8010-101010101010',
              personId: alexId,
              firstName: 'Alex',
              lastName: 'Athlete',
              teamSeasonId: blueTeamId,
              teamName: 'Blue',
              rating: 4.5,
              locked: false,
              status: 'placed',
              version: 1,
            },
            {
              id: '20202020-2020-4020-8020-202020202020',
              personId: jordanId,
              firstName: 'Jordan',
              lastName: 'Player',
              teamSeasonId: goldTeamId,
              teamName: 'Gold',
              rating: 4,
              locked: false,
              status: 'placed',
              version: 1,
            },
          ],
        },
      }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/boards/${boardId}/offers`,
    (route) =>
      route.fulfill({
        json: {
          boardId,
          status: 'draft',
          teams: [
            {
              teamSeasonId: blueTeamId,
              teamName: 'Blue',
              rosterLimit: 12,
              sent: 0,
              accepted: 0,
              declined: 0,
              expired: 0,
              withdrawn: 0,
              placed: 1,
            },
            {
              teamSeasonId: goldTeamId,
              teamName: 'Gold',
              rosterLimit: 12,
              sent: 0,
              accepted: 0,
              declined: 0,
              expired: 0,
              withdrawn: 0,
              placed: 1,
            },
          ],
          nextInLine: [],
        },
      }),
  );

  await page.goto(`/console/orgs/${orgId}/evaluations/${eventId}`);
  await expect(
    page.getByRole('heading', { name: 'U10 soccer tryout' }),
  ).toBeVisible();
  const registrationQr = page.getByLabel('Scan registration QR code');
  await registrationQr.fill(`registration:${tryoutRegistrationId}`);
  await page
    .getByRole('button', { name: 'Check in scanned registration' })
    .click();
  await expect(page.getByRole('cell', { name: 'checked_in' })).toBeVisible();
  expect(checkIns).toEqual([{ late: false }]);

  await page
    .getByRole('button', { name: 'Compute normalized results' })
    .click();
  await expect(page.getByRole('cell', { name: '4.50' })).toBeVisible();
  await page.getByLabel('Target division').selectOption(divisionId);
  await page.getByLabel('Evaluation group').selectOption(groupId);
  await page.getByRole('button', { name: 'Build placement draft' }).click();
  await expect(page.getByText('Alex Athlete → Blue')).toBeVisible();
  await expect(page.getByText('Jordan Player → Gold')).toBeVisible();
  expect(boardRequests).toEqual([
    expect.objectContaining({
      divisionId,
      evaluationGroupId: groupId,
      seed: 1,
    }),
  ]);
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('family accepts a team offer and continues to registration checkout', async ({
  page,
}) => {
  const acceptances: Array<Record<string, unknown>> = [];
  await mockAuthenticatedAccount(page);
  await page.route(`**/api/v1/orgs/${orgId}/workspace`, (route) =>
    route.fulfill({ json: { name: 'North Club' } }),
  );
  await page.route(`**/api/v1/evaluations/orgs/${orgId}/me/offers`, (route) =>
    route.fulfill({
      json: [
        {
          id: offerId,
          personId,
          firstName: 'Alex',
          lastName: 'Athlete',
          teamSeasonId: blueTeamId,
          teamName: 'Blue U10',
          amountCents: 25000,
          depositCents: 5000,
          expiresAt: '2026-10-01T00:00:00.000Z',
          message: 'Welcome to the team.',
          status: 'sent',
          version: 1,
          acceptanceReady: true,
        },
      ],
    }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/offers/${offerId}/accept`,
    async (route) => {
      acceptances.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      await route.fulfill({
        json: {
          offerId,
          status: 'accepted',
          registrationId: participantId,
          checkoutId,
          invoiceId: eventId,
          depositCents: 5000,
          paymentPlanId: null,
        },
      });
    },
  );

  await page.goto(`/portal/orgs/${orgId}/offers`);
  await expect(
    page.getByRole('heading', { name: 'Team offers' }),
  ).toBeVisible();
  await expect(page.getByText('Welcome to the team.')).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page
    .getByRole('button', { name: 'Accept and continue to deposit checkout' })
    .click();
  await expect(page).toHaveURL(
    `/portal/orgs/${orgId}/register/checkouts/${checkoutId}/requirements`,
  );
  expect(acceptances).toHaveLength(1);
});

test('family can decline while online checkout is unavailable', async ({
  page,
}) => {
  const declines: Array<Record<string, unknown>> = [];
  await mockAuthenticatedAccount(page);
  await page.route(`**/api/v1/orgs/${orgId}/workspace`, (route) =>
    route.fulfill({ json: { name: 'North Club' } }),
  );
  await page.route(`**/api/v1/evaluations/orgs/${orgId}/me/offers`, (route) =>
    route.fulfill({
      json: [
        {
          id: offerId,
          personId,
          firstName: 'Alex',
          lastName: 'Athlete',
          teamSeasonId: blueTeamId,
          teamName: 'Blue U10',
          amountCents: 25000,
          depositCents: 5000,
          expiresAt: '2026-10-01T00:00:00.000Z',
          message: null,
          status: 'sent',
          version: 2,
          acceptanceReady: false,
        },
      ],
    }),
  );
  await page.route(
    `**/api/v1/evaluations/orgs/${orgId}/offers/${offerId}/decline`,
    async (route) => {
      declines.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { offerId, status: 'declined' } });
    },
  );

  await page.goto(`/portal/orgs/${orgId}/offers`);
  await expect(
    page.getByText('Online checkout is unavailable for this offer.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Accept and continue to deposit checkout',
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Decline offer' }),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  await page
    .getByLabel('Reason for declining')
    .fill('Family schedule conflict');
  await page.getByRole('button', { name: 'Decline offer' }).click();
  await expect(
    page.getByText(
      'Offer declined. The placement spot is available to the organization.',
    ),
  ).toBeVisible();
  expect(declines).toEqual([
    { reason: 'Family schedule conflict', expectedVersion: 2 },
  ]);
});
