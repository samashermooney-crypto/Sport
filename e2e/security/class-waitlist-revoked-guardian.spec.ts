import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test.fixme('QA-SEC-010 / Track I: a revoked guardian cannot read a former class waitlist entry', async ({
  request,
}) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const childId = await factories.person(actor, {
      firstName: 'Revoked',
      lastName: randomUUID().slice(0, 8),
      dateOfBirth: '2018-06-01',
    });
    const householdId = await factories.household(actor);
    const program = await factories.program(actor);
    const offeringId = newId();
    const waitlistId = newId();
    const guardianLinkId = newId();
    const withOrg = createWithOrg(database);

    await withOrg(actor, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ mode: 'class', status: 'published', visibility: 'public' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: actor.orgId,
          household_id: householdId,
          person_id: childId,
          role: 'athlete',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: guardianLinkId,
          org_id: actor.orgId,
          person_id: childId,
          account_id: actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('class_offerings')
        .values({
          id: offeringId,
          org_id: actor.orgId,
          program_id: program.programId,
          name: 'Waitlist privacy fixture',
          capacity: 8,
          instructor_ratio: '8',
          billing: 'term',
          price_cents: 0,
        })
        .execute();
      await trx
        .insertInto('class_waitlist_entries')
        .values({
          id: waitlistId,
          org_id: actor.orgId,
          class_offering_id: offeringId,
          person_id: childId,
          household_id: householdId,
          account_id: actor.accountId,
          position: 1,
          status: 'offered',
          offered_at: new Date(),
          offer_expires_at: new Date(Date.now() + 60_000),
        })
        .execute();
      await trx
        .updateTable('person_account_links')
        .set({ revoked_at: new Date() })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', guardianLinkId)
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
    const response = await request.get(
      `http://127.0.0.1:${String(3001 + offset)}/api/v1/classes/orgs/${actor.orgId}/me/waitlist`,
      {
        headers: {
          Cookie: `__Host-athlentry_session=${session.token}`,
        },
      },
    );
    expect(response.status()).toBe(200);
    const payload = (await response.json()) as {
      items: Array<{ id: string; personName: string }>;
    };
    expect(payload.items).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain(waitlistId);
    expect(JSON.stringify(payload)).not.toContain('Revoked');
  } finally {
    await database.destroy();
  }
});
