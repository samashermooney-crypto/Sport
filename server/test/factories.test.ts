import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';

import { createTestFactories } from './factories';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

describe('spine test factories', () => {
  it('builds valid linked rows and enforces org scope for any tenant table', async () => {
    const factory = createTestFactories(database);
    const orgA = await factory.actor();
    const orgB = await factory.actor();
    const personId = await factory.person(orgA);
    const householdId = await factory.household(orgA);
    const program = await factory.program(orgA);
    const createdTeam = await factory.team(orgA, program);
    const registrationId = await factory.registration(
      orgA,
      program,
      personId,
      householdId,
    );
    const invoiceId = await factory.invoice(orgA, 1);
    const eventId = await factory.event(orgA);
    const contestId = await factory.contest(
      orgA,
      eventId,
      program.sportProfileId,
    );
    await factory.row(orgA, 'capacity_counters', {
      id: newId(),
      org_id: orgA.orgId,
      subject_type: 'offering',
      subject_id: program.offeringId,
    });
    expect(createdTeam.teamSeasonId).toBeTruthy();
    expect(registrationId).toBeTruthy();
    expect(invoiceId).toBeTruthy();
    expect(contestId).toBeTruthy();
    expect(
      await factory.scoped(orgA, (trx) =>
        trx
          .selectFrom('people')
          .select('id')
          .where('id', '=', personId)
          .executeTakeFirst(),
      ),
    ).toMatchObject({ id: personId });
    expect(
      await factory.scoped(orgB, (trx) =>
        trx
          .selectFrom('people')
          .select('id')
          .where('id', '=', personId)
          .executeTakeFirst(),
      ),
    ).toBeUndefined();
    await expect(
      factory.row(orgB, 'capacity_counters', {
        id: newId(),
        org_id: orgA.orgId,
        subject_type: 'offering',
        subject_id: program.offeringId,
      }),
    ).rejects.toThrow('different organization');
  });
});
