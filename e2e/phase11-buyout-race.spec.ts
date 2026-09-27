import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import {
  buyOutVolunteerRequirement,
  createVolunteerRequirement,
} from '../server/src/modules/volunteers/service';
import { createTestFactories } from '../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test.fixme('QA-ACC-039 / Track H: concurrent volunteer buyouts leave no payable orphan invoice', async () => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const householdId = await factories.household(actor);
    const athleteId = await factories.person(actor, {
      firstName: 'Jordan',
      lastName: 'Volunteer',
      dateOfBirth: '2015-04-02',
    });
    await factories.registration(actor, program, athleteId, householdId);
    await factories.scoped(actor, (trx) =>
      Promise.all([
        trx
          .insertInto('household_members')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            household_id: householdId,
            person_id: athleteId,
            role: 'athlete',
            financially_responsible: true,
          })
          .execute(),
        trx
          .insertInto('person_account_links')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            person_id: athleteId,
            account_id: actor.accountId,
            relationship: 'guardian',
            verified_at: new Date(),
          })
          .execute(),
      ]).then(() => undefined),
    );
    const requirement = await createVolunteerRequirement(database, actor, {
      programId: program.programId,
      unit: 'shifts',
      amountPerHousehold: 1,
      buyoutPriceCents: 5_000,
      deadline: '2026-12-31',
      autoInvoiceShortfall: false,
      noticeDays: 14,
      countsCoachRoles: false,
    });

    const attempts = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((creationKey) =>
        buyOutVolunteerRequirement(
          database,
          actor,
          {
            requirementId: requirement.id,
            householdId,
            units: 1,
            creationKey,
          },
          new Date('2026-09-27T12:00:00.000Z'),
        ),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(1);

    const persisted = await createWithOrg(database)(actor, async (trx) => ({
      buyouts: await trx
        .selectFrom('volunteer_buyouts')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('requirement_id', '=', requirement.id)
        .where('household_id', '=', householdId)
        .execute(),
      invoiceLines: await trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('kind', '=', 'volunteer_buyout')
        .execute(),
    }));
    expect(persisted.buyouts).toHaveLength(1);
    expect(persisted.invoiceLines).toHaveLength(1);
  } finally {
    await database.destroy();
  }
});
