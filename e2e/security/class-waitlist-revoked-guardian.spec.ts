import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';
import { e2eDatabaseUrl } from '../database';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('QA-SEC-010 / Track I: a revoked guardian cannot read or act on class waitlist offers', async ({
  request,
}) => {
  const database = createDatabase(e2eDatabaseUrl('app'));
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const childId = await factories.person(actor, {
      firstName: 'Revoked',
      lastName: randomUUID().slice(0, 8),
      dateOfBirth: '2018-06-01',
    });
    const declineChildId = await factories.person(actor, {
      firstName: 'Revoked',
      lastName: randomUUID().slice(0, 8),
      dateOfBirth: '2017-06-01',
    });
    const householdId = await factories.household(actor);
    const program = await factories.program(actor);
    const offeringId = newId();
    const acceptWaitlistId = newId();
    const declineWaitlistId = newId();
    const guardianLinkIds = [newId(), newId()];
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
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: actor.orgId,
          household_id: householdId,
          person_id: declineChildId,
          role: 'athlete',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: guardianLinkIds[0] ?? newId(),
          org_id: actor.orgId,
          person_id: childId,
          account_id: actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: guardianLinkIds[1] ?? newId(),
          org_id: actor.orgId,
          person_id: declineChildId,
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
          id: acceptWaitlistId,
          org_id: actor.orgId,
          class_offering_id: offeringId,
          person_id: childId,
          household_id: householdId,
          account_id: actor.accountId,
          position: 1,
          status: 'offered',
          offered_at: new Date(),
          offer_expires_at: new Date(Date.now() + 86_400_000),
        })
        .execute();
      await trx
        .insertInto('class_waitlist_entries')
        .values({
          id: declineWaitlistId,
          org_id: actor.orgId,
          class_offering_id: offeringId,
          person_id: declineChildId,
          household_id: householdId,
          account_id: actor.accountId,
          position: 2,
          status: 'offered',
          offered_at: new Date(),
          offer_expires_at: new Date(Date.now() + 86_400_000),
        })
        .execute();
      await trx
        .updateTable('person_account_links')
        .set({ revoked_at: new Date() })
        .where('org_id', '=', actor.orgId)
        .where('id', 'in', guardianLinkIds)
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
    const writeHeaders = {
      Cookie: `__Host-athlentry_session=${session.token}`,
      Origin: `https://127.0.0.1:${String(5173 + offset)}`,
      'X-Athlentry-Request': '1',
    };
    const acceptResponse = await request.post(
      `http://127.0.0.1:${String(3001 + offset)}/api/v1/classes/orgs/${actor.orgId}/me/waitlist/${acceptWaitlistId}/accept`,
      {
        headers: { ...writeHeaders, 'Idempotency-Key': newId() },
        data: {
          classOfferingId: offeringId,
          personId: childId,
          householdId,
          startsOn: new Date().toISOString().slice(0, 10),
          classesPerWeek: 1,
          trial: false,
          trialSessionId: null,
          paymentMethodId: null,
          autopay: false,
          billingDay: 1,
        },
      },
    );
    const declineResponse = await request.post(
      `http://127.0.0.1:${String(3001 + offset)}/api/v1/classes/orgs/${actor.orgId}/me/waitlist/${declineWaitlistId}/decline`,
      { headers: writeHeaders },
    );
    expect(response.status()).toBe(200);
    const payload = (await response.json()) as {
      items: Array<{ id: string; personId: string; personName: string }>;
    };
    expect(payload.items).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain(acceptWaitlistId);
    expect(JSON.stringify(payload)).not.toContain(declineWaitlistId);
    expect(JSON.stringify(payload)).not.toContain('Revoked');
    expect(acceptResponse.status()).toBe(404);
    expect(declineResponse.status()).toBe(404);
    const remainingOffers = await withOrg(actor, (trx) =>
      trx
        .selectFrom('class_waitlist_entries')
        .select(['id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('id', 'in', [acceptWaitlistId, declineWaitlistId])
        .execute(),
    );
    expect(
      Object.fromEntries(remainingOffers.map(({ id, status }) => [id, status])),
    ).toEqual({
      [acceptWaitlistId]: 'offered',
      [declineWaitlistId]: 'offered',
    });
  } finally {
    await database.destroy();
  }
});
