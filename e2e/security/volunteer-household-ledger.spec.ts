import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createVolunteerRequirement } from '../../server/src/modules/volunteers/service';
import { createTestFactories } from '../../server/test/factories';
import { e2eDatabaseUrl } from '../database';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('QA-SEC-009 / Track H: scoped director cannot read another household volunteer ledger', async ({
  request,
}) => {
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  try {
    const factories = createTestFactories(database);
    const owner = await factories.actor();
    const program = await factories.program(owner);
    const directorProgram = await factories.program(owner);
    const householdId = await factories.household(owner);
    const athleteId = await factories.person(owner, {
      firstName: 'Private',
      lastName: 'Volunteer',
      dateOfBirth: '2015-04-02',
    });
    await factories.registration(owner, program, athleteId, householdId);
    await factories.scoped(owner, (trx) =>
      trx
        .insertInto('household_members')
        .values({
          id: randomUUID(),
          org_id: owner.orgId,
          household_id: householdId,
          person_id: athleteId,
          role: 'athlete',
          financially_responsible: true,
        })
        .execute()
        .then(() => undefined),
    );
    await createVolunteerRequirement(database, owner, {
      programId: program.programId,
      unit: 'shifts',
      amountPerHousehold: 2,
      deadline: '2026-12-31',
      autoInvoiceShortfall: false,
      noticeDays: 14,
      countsCoachRoles: false,
    });

    const directorAccountId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: directorAccountId,
        email: `qa-director-${randomUUID()}@example.invalid`,
        first_name: 'Scoped',
        last_name: 'Director',
        date_of_birth: '1985-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: randomUUID(),
          org_id: owner.orgId,
          account_id: directorAccountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: randomUUID(),
          org_id: owner.orgId,
          account_id: directorAccountId,
          role: 'director',
          scope_type: 'program',
          scope_id: directorProgram.programId,
          granted_by: owner.accountId,
          pending_mfa: false,
        })
        .execute();
    });
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: directorAccountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    const response = await request.get(
      `http://127.0.0.1:${String(3001 + offset)}/api/v1/volunteers/orgs/${owner.orgId}/households/${householdId}/ledger`,
      {
        headers: {
          Cookie: `__Host-athlentry_session=${session.token}`,
        },
      },
    );

    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('Private Volunteer');
  } finally {
    await database.destroy();
  }
});
