import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import { createWithOrg } from '../../db/withOrg.js';

import { enqueueRegistrationNotice } from './notices.js';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

async function fixture() {
  const orgId = newId();
  const accountId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `registration-inbox-${randomUUID()}@example.invalid`,
      first_name: 'Family',
      last_name: 'One',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `registration-inbox-${randomUUID().slice(0, 10)}`,
      name: 'Registration inbox test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  return {
    orgId,
    accountId,
    context: { orgId, actor: { accountId } },
  };
}

describe('registration notice fanout', () => {
  it('writes one in-app notification with the email outbox item and dedupes replay', async () => {
    const { orgId, accountId, context } = await fixture();
    const sourceId = newId();
    const runWithOrg = createWithOrg(database);

    expect(
      await runWithOrg(context, (trx) =>
        enqueueRegistrationNotice(trx, context, {
          kind: 'waitlist_offer',
          sourceId,
          accountId,
        }),
      ),
    ).toBe(true);
    expect(
      await runWithOrg(context, (trx) =>
        enqueueRegistrationNotice(trx, context, {
          kind: 'waitlist_offer',
          sourceId,
          accountId,
        }),
      ),
    ).toBe(false);

    const rows = await runWithOrg(context, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['type', 'payload'])
        .where('org_id', '=', orgId)
        .where('account_id', '=', accountId)
        .execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'registration.offered',
      payload: { href: `/portal/orgs/${orgId}/registrations` },
    });
  });

  it('rolls back the inbox item when its registration transaction fails', async () => {
    const { orgId, accountId, context } = await fixture();
    const sourceId = newId();
    const runWithOrg = createWithOrg(database);

    await expect(
      runWithOrg(context, async (trx) => {
        await enqueueRegistrationNotice(trx, context, {
          kind: 'registration_confirmed',
          sourceId,
          accountId,
        });
        throw new Error('simulate source transaction rollback');
      }),
    ).rejects.toThrow('simulate source transaction rollback');

    const counts = await runWithOrg(context, async (trx) => ({
      notices: await trx
        .selectFrom('registration_notice_outbox')
        .select('id')
        .where('org_id', '=', orgId)
        .where('source_id', '=', sourceId)
        .execute(),
      notifications: await trx
        .selectFrom('notifications')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', accountId)
        .execute(),
    }));
    expect(counts.notices).toHaveLength(0);
    expect(counts.notifications).toHaveLength(0);
  });
});
