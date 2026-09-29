import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';
import { e2eDatabaseUrl } from './database';


test('family re-registers two returning siblings, signs waivers, and chooses uniform sizes', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const previousProgram = await factories.program(actor);
    const householdId = await factories.household(actor);
    const participants = [
      {
        id: await factories.person(actor, {
          firstName: 'Maya',
          lastName: 'Sibling',
          dateOfBirth: '2014-05-20',
        }),
        name: 'Maya Sibling',
      },
      {
        id: await factories.person(actor, {
          firstName: 'Noah',
          lastName: 'Sibling',
          dateOfBirth: '2016-02-14',
        }),
        name: 'Noah Sibling',
      },
      {
        id: await factories.person(actor, {
          firstName: 'Ava',
          lastName: 'Sibling',
          dateOfBirth: '2020-01-01',
        }),
        name: 'Ava Sibling',
      },
    ];
    const waiverDocumentId = crypto.randomUUID();
    const terms = {
      policy: {
        rules: [],
        afterLastBps: 10_000,
        serviceFeeRefund: 'proportional' as const,
      },
      approvalThresholdCents: 10_000,
      refundApplicationFee: true,
    };
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('organizations')
        .set({ settings: { refundTerms: terms } })
        .where('id', '=', actor.orgId)
        .execute();
      await trx
        .updateTable('programs')
        .set({
          status: 'registration_open',
          visibility: 'public',
          eligibility: { minAge: 8, maxAge: 16 },
          settings: {
            volunteerRequirement: {
              required: true,
              buyoutCents: 1000,
              description: 'Choose a volunteer commitment for your household.',
            },
          },
        })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('registration_offerings')
        .set({
          active: true,
          visibility: 'public',
          requires_approval: false,
          add_ons: JSON.stringify([
            {
              key: 'uniform-kit',
              name: 'Uniform kit',
              priceCents: 0,
              required: true,
              sizes: ['Youth S', 'Youth M'],
            },
          ]),
          waiver_document_ids: [waiverDocumentId],
        })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.offeringId)
        .execute();
      await trx
        .insertInto('waiver_documents')
        .values({
          id: waiverDocumentId,
          org_id: actor.orgId,
          name: 'Youth sports waiver',
          body_html:
            '<p>Families agree to the youth sports participation terms.</p>',
          requires: 'guardian_if_minor',
          renewal: 'every_registration',
          published_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('household_members')
        .values(
          participants.map((participant) => ({
            id: crypto.randomUUID(),
            org_id: actor.orgId,
            household_id: householdId,
            person_id: participant.id,
            role: 'athlete' as const,
            financially_responsible: false,
          })),
        )
        .execute();
      await trx
        .insertInto('person_account_links')
        .values(
          participants.map((participant) => ({
            id: crypto.randomUUID(),
            org_id: actor.orgId,
            person_id: participant.id,
            account_id: actor.accountId,
            relationship: 'guardian' as const,
            verified_at: new Date(),
          })),
        )
        .execute();
      await trx
        .insertInto('capacity_counters')
        .values(
          [
            ['program', program.programId],
            ['division', program.divisionId],
            ['offering', program.offeringId],
          ].map(([subjectType, subjectId]) => ({
            id: crypto.randomUUID(),
            org_id: actor.orgId,
            subject_type: subjectType as 'program' | 'division' | 'offering',
            subject_id: subjectId ?? '',
            capacity: 100,
          })),
        )
        .execute();
    });
    for (const participant of participants.slice(0, 2))
      await factories.registration(
        actor,
        previousProgram,
        participant.id,
        householdId,
      );
    const priorRegistrations = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('registrations')
        .select(['person_id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('program_id', '=', previousProgram.programId)
        .where(
          'person_id',
          'in',
          participants.slice(0, 2).map((participant) => participant.id),
        )
        .execute(),
    );
    expect(priorRegistrations).toHaveLength(2);
    expect(
      priorRegistrations.every(({ status }) => status === 'confirmed'),
    ).toBe(true);

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
    await page.goto(`/portal/orgs/${actor.orgId}/registrations`);
    await page
      .getByRole('link', { name: 'Register Maya Sibling again' })
      .click();
    const journeyStartedAt = Date.now();
    const programFilter = page.getByLabel('Show programs for');
    await programFilter.selectOption(
      `${participants[2]?.id ?? ''}:${householdId}`,
    );
    await expect(
      page.getByText('No programs are available for this filter.'),
    ).toBeVisible();
    await programFilter.selectOption('');
    const visitedScreens = new Set<string>();
    const expectJourneyScreen = async (name: string, timeout = 5000) => {
      await expect(page.getByRole('heading', { name })).toBeVisible({
        timeout,
      });
      visitedScreens.add(name);
      expect(visitedScreens.size).toBeLessThanOrEqual(4);
    };
    await expectJourneyScreen('Find a program');
    expect(await accessibilityViolations(page)).toEqual([]);
    const firstParticipant = participants[0];
    const secondParticipant = participants[1];
    if (!firstParticipant || !secondParticipant)
      throw new Error('Family participant fixtures are missing');
    const participantPicker = page.getByLabel('Participant');
    await expect(participantPicker).toHaveValue(
      `${firstParticipant.id}:${householdId}`,
    );
    await participantPicker.selectOption(
      `${firstParticipant.id}:${householdId}`,
    );
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await participantPicker.selectOption(
      `${secondParticipant.id}:${householdId}`,
    );
    await page.getByRole('button', { name: 'Add to cart' }).click();
    const cart = page.locator('[aria-labelledby="cart-title"]');
    await expect(cart.getByText('Maya Sibling')).toBeVisible();
    await expect(cart.getByText('Noah Sibling')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Continue to review' }).click();

    await expectJourneyScreen('Participant details');
    expect(await accessibilityViolations(page)).toEqual([]);
    const parent = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('accounts')
        .select(['first_name', 'last_name'])
        .where('id', '=', actor.accountId)
        .executeTakeFirstOrThrow(),
    );
    const guardianName = `${parent.first_name} ${parent.last_name}`;
    for (const participant of participants.slice(0, 2)) {
      const section = page.locator('section.money-panel').filter({
        has: page.getByRole('heading', {
          name: `${participant.name} · Player`,
        }),
      });
      await section
        .getByRole('checkbox', {
          name: 'I have read and agree to this waiver.',
        })
        .check();
      await section
        .getByLabel('Guardian or adult participant signer full name')
        .fill(guardianName);
      await expect(section.getByLabel('Uniform kit')).toBeChecked();
      const uniformSize = section.getByLabel('Size');
      const selectedSize = participant.name.startsWith('Maya')
        ? 'Youth M'
        : 'Youth S';
      await uniformSize.selectOption(selectedSize);
      await expect(uniformSize).toHaveValue(selectedSize);
      await expect(
        section.getByRole('radio', { name: 'I will volunteer' }),
      ).toBeChecked();
    }
    await page.getByRole('button', { name: 'Continue to review' }).click();

    await expectJourneyScreen('Review your registration');
    expect(await accessibilityViolations(page)).toEqual([]);
    await page
      .getByRole('checkbox', {
        name: 'I have read and accept these refund terms.',
      })
      .check();
    await page.getByRole('button', { name: 'Continue to payment' }).click();
    await expectJourneyScreen('Registration confirmed', 30_000);
    expect(await accessibilityViolations(page)).toEqual([]);
    expect(visitedScreens.size).toBe(4);

    expect(Date.now() - journeyStartedAt).toBeLessThan(120_000);
    const registrations = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('registrations')
        .select(['id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where(
          'person_id',
          'in',
          participants.map((participant) => participant.id),
        )
        .where('program_id', '=', program.programId)
        .execute(),
    );
    expect(registrations).toHaveLength(2);
    expect(
      registrations.every(
        (registration) => registration.status === 'confirmed',
      ),
    ).toBe(true);
    const signatures = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('waiver_signatures')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('waiver_document_id', '=', waiverDocumentId)
        .execute(),
    );
    expect(signatures).toHaveLength(2);
  } finally {
    await database.destroy();
  }
});

test('waitlist cancellation offers a spot, acceptance confirms, and expiry advances the queue', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const householdId = await factories.household(actor);
    const registeredPeople = [];
    for (const person of [
      { firstName: 'Jordan', lastName: 'Family' },
      { firstName: 'Morgan', lastName: 'Family' },
      { firstName: 'Riley', lastName: 'Family' },
    ]) {
      registeredPeople.push({
        id: await factories.person(actor, {
          ...person,
          dateOfBirth: '2014-05-20',
        }),
      });
    }
    const waitlisted = [];
    for (const person of [
      { firstName: 'Taylor', lastName: 'Family' },
      { firstName: 'Casey', lastName: 'Family' },
      { firstName: 'Avery', lastName: 'Family' },
    ]) {
      waitlisted.push({
        id: await factories.person(actor, {
          ...person,
          dateOfBirth: '2016-02-14',
        }),
      });
    }
    const registeredPersonIds = registeredPeople.map((person) => person.id);
    const waitlistedPersonIds = waitlisted.map((person) => person.id);
    const refundTerms = {
      policy: {
        rules: [],
        afterLastBps: 10_000,
        serviceFeeRefund: 'proportional' as const,
      },
      approvalThresholdCents: 10_000,
      refundApplicationFee: true,
    };
    const utcOffset = 12 - new Date().getUTCHours();
    const timezone =
      'Etc/GMT' +
      (utcOffset > 0 ? '-' : utcOffset < 0 ? '+' : '') +
      (utcOffset === 0 ? '' : String(Math.abs(utcOffset)));
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('organizations')
        .set({ timezone, settings: { refundTerms } })
        .where('id', '=', actor.orgId)
        .execute();
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .where('role', '=', 'owner')
        .execute();
      await trx
        .updateTable('programs')
        .set({
          status: 'registration_open',
          visibility: 'public',
          settings: { waitlistMode: 'auto', offerExpiryHours: 4 },
        })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('registration_offerings')
        .set({
          active: true,
          visibility: 'public',
          waitlist_enabled: true,
        })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.offeringId)
        .execute();
      await trx
        .insertInto('household_members')
        .values(
          [...registeredPersonIds, ...waitlistedPersonIds].map((personId) => ({
            id: crypto.randomUUID(),
            org_id: actor.orgId,
            household_id: householdId,
            person_id: personId,
            role: 'athlete' as const,
            financially_responsible: false,
          })),
        )
        .execute();
      await trx
        .insertInto('person_account_links')
        .values(
          [...registeredPersonIds, ...waitlistedPersonIds].map((personId) => ({
            id: crypto.randomUUID(),
            org_id: actor.orgId,
            person_id: personId,
            account_id: actor.accountId,
            relationship: 'guardian' as const,
            verified_at: new Date(),
          })),
        )
        .execute();
      await trx
        .insertInto('capacity_counters')
        .values(
          [
            ['program', program.programId],
            ['division', program.divisionId],
            ['offering', program.offeringId],
          ].map(([subjectType, subjectId]) => ({
            id: crypto.randomUUID(),
            org_id: actor.orgId,
            subject_type: subjectType as 'program' | 'division' | 'offering',
            subject_id: subjectId ?? '',
            capacity: registeredPersonIds.length,
            confirmed: registeredPersonIds.length,
          })),
        )
        .execute();
    });
    const registrationIds = [];
    for (const personId of registeredPersonIds) {
      registrationIds.push(
        await factories.registration(actor, program, personId, householdId),
      );
    }
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
    await page.goto(`/portal/orgs/${actor.orgId}/register`);
    expect(await accessibilityViolations(page)).toEqual([]);
    const participant = page.getByLabel(
      'Participant for Fixture League · Player waitlist',
    );
    for (const [index, personId] of waitlistedPersonIds.entries()) {
      await participant.selectOption(personId + ':' + householdId);
      await page.getByRole('button', { name: 'Join waitlist' }).click();
      await expect(
        page.getByText('You are #' + String(index + 1) + ' on this waitlist.'),
      ).toBeVisible();
    }

    const entries = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('waitlist_entries')
        .select(['id', 'person_id', 'position', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('offering_id', '=', program.offeringId)
        .orderBy('position')
        .execute(),
    );
    expect(entries).toHaveLength(waitlistedPersonIds.length);
    expect(
      entries.map(({ person_id, position, status }) => ({
        person_id,
        position,
        status,
      })),
    ).toEqual(
      waitlistedPersonIds.map((personId, index) => ({
        person_id: personId,
        position: index + 1,
        status: 'waiting',
      })),
    );

    const baseUrl = String(testInfo.project.use.baseURL);
    const cancelAsStaff = async (registrationId: string): Promise<void> => {
      const response = await page
        .context()
        .request.post(
          new URL(
            '/api/v1/registration/orgs/' +
              actor.orgId +
              '/registrations/' +
              registrationId +
              '/cancel',
            baseUrl,
          ).toString(),
          {
            data: { reason: 'Releasing the seat for the waitlist journey' },
            headers: {
              Origin: new URL(baseUrl).origin,
              'X-Athlentry-Request': '1',
              'Idempotency-Key': crypto.randomUUID(),
            },
          },
        );
      expect(response.status(), await response.text()).toBe(200);
    };

    const firstRegistrationId = registrationIds[0];
    const secondRegistrationId = registrationIds[1];
    const thirdRegistrationId = registrationIds[2];
    const firstWaitlistedPersonId = waitlistedPersonIds[0];
    const secondWaitlistedPersonId = waitlistedPersonIds[1];
    const thirdWaitlistedPersonId = waitlistedPersonIds[2];
    if (
      !firstRegistrationId ||
      !secondRegistrationId ||
      !thirdRegistrationId ||
      !firstWaitlistedPersonId ||
      !secondWaitlistedPersonId ||
      !thirdWaitlistedPersonId
    )
      throw new Error('Waitlist journey fixtures are incomplete');

    await cancelAsStaff(firstRegistrationId);
    const offeredToFirst = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('waitlist_entries')
        .select(['id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('person_id', '=', firstWaitlistedPersonId)
        .executeTakeFirstOrThrow(),
    );
    expect(offeredToFirst.status).toBe('offered');
    await page.goto(`/portal/orgs/${actor.orgId}/registrations`);
    await expect(
      page.getByRole('heading', { name: 'My registrations' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Accept offer' }).click();
    await expect(
      page.getByRole('heading', { name: 'Participant details' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue to review' }).click();
    await expect(
      page.getByRole('heading', { name: 'Review your registration' }),
    ).toBeVisible();
    await page
      .getByRole('checkbox', {
        name: 'I have read and accept these refund terms.',
      })
      .check();
    await page.getByRole('button', { name: 'Continue to payment' }).click();
    await expect(
      page.getByRole('heading', { name: 'Registration confirmed' }),
    ).toBeVisible();

    const acceptedRegistration = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('registrations')
        .select(['id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('program_id', '=', program.programId)
        .where('person_id', '=', firstWaitlistedPersonId)
        .executeTakeFirstOrThrow(),
    );
    expect(acceptedRegistration.status).toBe('confirmed');
    const acceptedWaitlistEntry = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('waitlist_entries')
        .select(['status', 'registration_id'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', offeredToFirst.id)
        .executeTakeFirstOrThrow(),
    );
    expect(acceptedWaitlistEntry).toEqual({
      status: 'accepted',
      registration_id: acceptedRegistration.id,
    });

    await cancelAsStaff(secondRegistrationId);
    const offeredToSecond = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('waitlist_entries')
        .select(['id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('person_id', '=', secondWaitlistedPersonId)
        .executeTakeFirstOrThrow(),
    );
    expect(offeredToSecond.status).toBe('offered');
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('waitlist_entries')
        .set({ offer_expires_at: new Date(Date.now() - 60_000) })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', offeredToSecond.id)
        .execute();
    });
    await cancelAsStaff(thirdRegistrationId);
    const advancedQueue = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('waitlist_entries')
        .select(['person_id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('offering_id', '=', program.offeringId)
        .execute(),
    );
    expect(
      advancedQueue.find(
        (entry) => entry.person_id === secondWaitlistedPersonId,
      )?.status,
    ).toBe('expired');
    expect(
      advancedQueue.find((entry) => entry.person_id === thirdWaitlistedPersonId)
        ?.status,
    ).toBe('offered');
  } finally {
    await database.destroy();
  }
});
