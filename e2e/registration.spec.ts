import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('family registers two siblings together, signs waivers, and chooses uniform sizes', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const startedAt = Date.now();
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/portal/orgs/${actor.orgId}/register`);
    await expect(
      page.getByRole('heading', { name: 'Find a program' }),
    ).toBeVisible();
    const firstParticipant = participants[0];
    const secondParticipant = participants[1];
    if (!firstParticipant || !secondParticipant)
      throw new Error('Family participant fixtures are missing');
    const participantPicker = page.getByLabel('Participant');
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
    await page.getByRole('button', { name: 'Continue to review' }).click();

    await expect(
      page.getByRole('heading', { name: 'Participant details' }),
    ).toBeVisible();
    const parent = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('accounts')
        .select(['first_name', 'last_name'])
        .where('id', '=', actor.accountId)
        .executeTakeFirstOrThrow(),
    );
    const guardianName = `${parent.first_name} ${parent.last_name}`;
    for (const participant of participants) {
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
      await expect(
        section.getByRole('radio', { name: 'I will volunteer' }),
      ).toBeChecked();
    }
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
    ).toBeVisible({ timeout: 30_000 });

    expect(Date.now() - startedAt).toBeLessThan(120_000);
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

test('family joins a full program waitlist from discovery', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const householdId = await factories.household(actor);
    const registeredPersonId = await factories.person(actor, {
      firstName: 'Jordan',
      lastName: 'Family',
      dateOfBirth: '2014-05-20',
    });
    const waitlistedPersonId = await factories.person(actor, {
      firstName: 'Taylor',
      lastName: 'Family',
      dateOfBirth: '2016-02-14',
    });
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('programs')
        .set({
          status: 'registration_open',
          visibility: 'public',
          settings: { waitlistMode: 'manual' },
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
          [registeredPersonId, waitlistedPersonId].map((personId) => ({
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
          [registeredPersonId, waitlistedPersonId].map((personId) => ({
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
            capacity: 1,
            confirmed: 1,
          })),
        )
        .execute();
    });
    await factories.registration(
      actor,
      program,
      registeredPersonId,
      householdId,
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/portal/orgs/${actor.orgId}/register`);
    const participant = page.getByLabel(
      'Participant for Fixture League · Player waitlist',
    );
    await participant.selectOption(`${waitlistedPersonId}:${householdId}`);
    await page.getByRole('button', { name: 'Join waitlist' }).click();
    await expect(page.getByText('You are #1 on this waitlist.')).toBeVisible();

    const entries = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('waitlist_entries')
        .select(['person_id', 'position', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('offering_id', '=', program.offeringId)
        .execute(),
    );
    expect(entries).toEqual([
      { person_id: waitlistedPersonId, position: 1, status: 'waiting' },
    ]);
  } finally {
    await database.destroy();
  }
});
