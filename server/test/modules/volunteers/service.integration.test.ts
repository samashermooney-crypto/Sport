import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../../src/db/kysely';
import {
  createVolunteerRequirement,
  createVolunteerRole,
  createVolunteerShift,
  householdVolunteerLedger,
  listMyVolunteerHouseholds,
  signupForVolunteerShift,
  updateVolunteerSignup,
  buyOutVolunteerRequirement,
  VolunteerAccessError,
  VolunteerConflictError,
} from '../../../src/modules/volunteers/service';
import { createTestFactories } from '../../../test/factories';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

describe('volunteer requirements and signups', () => {
  it('serializes a capacity-limited signup and credits a household volunteer toward its athlete requirement', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const householdId = await factories.household(actor);
    const athleteId = await factories.person(actor, {
      firstName: 'Jordan',
      dateOfBirth: '2015-04-02',
    });
    const adultOneId = await factories.person(actor, {
      firstName: 'Morgan',
      dateOfBirth: '1988-04-02',
    });
    const adultTwoId = await factories.person(actor, {
      firstName: 'Casey',
      dateOfBirth: '1986-04-02',
    });
    await factories.registration(actor, program, athleteId, householdId);
    await factories.scoped(actor, async (trx) => {
      for (const [personId, role, financiallyResponsible] of [
        [athleteId, 'athlete', true],
        [adultOneId, 'other_adult', false],
        [adultTwoId, 'other_adult', false],
      ] as const) {
        await trx
          .insertInto('household_members')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            household_id: householdId,
            person_id: personId,
            role,
            financially_responsible: financiallyResponsible,
          })
          .execute();
        await trx
          .insertInto('person_account_links')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            person_id: personId,
            account_id: actor.accountId,
            relationship: 'guardian',
            verified_at: new Date(),
          })
          .execute();
      }
    });
    const portalHousehold = (
      await listMyVolunteerHouseholds(database, actor)
    ).find((household) => household.id === householdId);
    expect(portalHousehold?.people.map((person) => person.name).sort()).toEqual(
      ['Casey Athlete', 'Jordan Athlete', 'Morgan Athlete'],
    );
    const facilityId = randomUUID();
    await factories.row(actor, 'facilities', {
      id: facilityId,
      org_id: actor.orgId,
      name: 'Riverside Field',
      ownership: 'owned',
    });
    const role = await createVolunteerRole(database, actor, {
      name: `Concessions ${randomUUID().slice(0, 6)}`,
      minimumAge: 18,
    });
    const requirement = await createVolunteerRequirement(database, actor, {
      programId: program.programId,
      unit: 'shifts',
      amountPerHousehold: 2,
      buyoutPriceCents: 5_000,
      deadline: '2026-12-01',
      autoInvoiceShortfall: false,
      noticeDays: 14,
      countsCoachRoles: false,
    });
    const shift = await createVolunteerShift(database, actor, {
      requirementId: requirement.id,
      volunteerRoleId: role.id,
      facilityId,
      startsAt: '2026-11-01T16:00:00.000Z',
      endsAt: '2026-11-01T18:00:00.000Z',
      slots: 1,
      creditHours: 2,
    });
    const now = new Date('2026-09-27T12:00:00.000Z');
    const attempts = await Promise.allSettled([
      signupForVolunteerShift(
        database,
        actor,
        { shiftId: shift.id, personId: adultOneId, householdId },
        now,
      ),
      signupForVolunteerShift(
        database,
        actor,
        { shiftId: shift.id, personId: adultTwoId, householdId },
        now,
      ),
    ]);
    const accepted = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof signupForVolunteerShift>>
      > => attempt.status === 'fulfilled',
    );
    const rejected = attempts.filter(
      (attempt) => attempt.status === 'rejected',
    );
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedAttempt = rejected[0];
    if (
      !rejectedAttempt ||
      !(rejectedAttempt.reason instanceof VolunteerConflictError)
    )
      throw new Error('Capacity-limited signup should reject one contender');
    const signup = accepted[0]?.value;
    if (!signup) throw new Error('Expected one accepted shift signup');

    const checkedIn = await updateVolunteerSignup(
      database,
      actor,
      signup.id,
      { status: 'checked_in', expectedVersion: 1 },
      now,
    );
    await expect(
      updateVolunteerSignup(
        database,
        actor,
        signup.id,
        {
          status: 'completed',
          hoursCredited: 3,
          expectedVersion: checkedIn.version,
        },
        now,
      ),
    ).rejects.toBeInstanceOf(VolunteerConflictError);
    const completed = await updateVolunteerSignup(
      database,
      actor,
      signup.id,
      {
        status: 'completed',
        hoursCredited: 2,
        expectedVersion: checkedIn.version,
      },
      now,
    );
    expect(completed).toMatchObject({ status: 'completed', hoursCredited: 2 });

    const beforeBuyout = await householdVolunteerLedger(
      database,
      actor,
      householdId,
      now,
    );
    expect(beforeBuyout.items).toContainEqual(
      expect.objectContaining({
        requirementId: requirement.id,
        subjectPersonId: null,
        required: 2,
        completed: 1,
        remaining: 1,
        buyoutAvailable: true,
      }),
    );

    const boughtOut = await buyOutVolunteerRequirement(
      database,
      actor,
      {
        requirementId: requirement.id,
        householdId,
        units: 1,
        creationKey: randomUUID(),
      },
      now,
    );
    expect(boughtOut).toMatchObject({ amountCents: 5_000, units: 1 });
    expect(boughtOut.invoiceId).toBeTruthy();
    const complete = await householdVolunteerLedger(
      database,
      actor,
      householdId,
      now,
    );
    expect(complete.items).toContainEqual(
      expect.objectContaining({
        requirementId: requirement.id,
        required: 2,
        completed: 1,
        boughtOut: 1,
        remaining: 0,
      }),
    );
  });

  it('requires a verified household guardian before signing a child up', async () => {
    const factories = createTestFactories(database);
    const org = await factories.actor();
    const householdId = await factories.household(org);
    const childId = await factories.person(org, { dateOfBirth: '2015-04-02' });
    await factories.scoped(org, (trx) =>
      trx
        .insertInto('household_members')
        .values({
          id: randomUUID(),
          org_id: org.orgId,
          household_id: householdId,
          person_id: childId,
          role: 'athlete',
          financially_responsible: true,
        })
        .execute()
        .then(() => undefined),
    );
    const facilityId = randomUUID();
    await factories.row(org, 'facilities', {
      id: facilityId,
      org_id: org.orgId,
      name: 'Community Field',
      ownership: 'owned',
    });
    const role = await createVolunteerRole(database, org, {
      name: `Field Marshal ${randomUUID().slice(0, 6)}`,
      minimumAge: 0,
    });
    const shift = await createVolunteerShift(database, org, {
      volunteerRoleId: role.id,
      facilityId,
      startsAt: '2026-11-01T16:00:00.000Z',
      endsAt: '2026-11-01T18:00:00.000Z',
      slots: 1,
      creditHours: 2,
    });

    await expect(
      signupForVolunteerShift(
        database,
        org,
        { shiftId: shift.id, personId: childId, householdId },
        new Date('2026-09-27T12:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(VolunteerAccessError);
  });
});
