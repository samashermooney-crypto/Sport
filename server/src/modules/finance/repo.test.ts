import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';
import type { OrgContext } from '../../db/withOrg.js';

import { ConnectAccountEventService } from './connect-events.js';
import type { ConnectAccount } from './connect.js';
import { PostgresConnectAccountRepository } from './repo.js';
import { resolveConnectAccountOrg } from './resolve-connect-account.js';

let database: Kysely<DB>;
let actor: OrgContext;
let other: OrgContext;
let repository: PostgresConnectAccountRepository;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  async function makeActor(): Promise<OrgContext> {
    const accountId = newId();
    const orgId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `finance-${randomUUID()}@example.invalid`,
        first_name: 'Finance',
        last_name: 'Actor',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `finance-${randomUUID().slice(0, 12)}`,
        name: 'Finance Test Organization',
        kind: 'club',
        timezone: 'America/Chicago',
      })
      .execute();
    return { orgId, actor: { accountId } };
  }
  actor = await makeActor();
  other = await makeActor();
  repository = new PostgresConnectAccountRepository(database, actor);
});

afterAll(async () => {
  await database.destroy();
});

describe('Postgres Connect account repository', () => {
  it('reserves one account per org and keeps the incomplete row fenced', async () => {
    const results = await Promise.all([
      repository.reserve(actor.orgId),
      repository.reserve(actor.orgId),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      'busy',
      'reserved',
    ]);
    expect(await repository.load(actor.orgId)).toBeNull();
  });

  it('saves and refreshes only the reserved org account', async () => {
    const account: ConnectAccount = {
      orgId: actor.orgId,
      stripeAccountId: 'acct_test_repo_1',
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsDue: ['business_profile.url'],
      disabledReason: null,
    };
    await repository.saveCreated(account);
    expect(await repository.load(actor.orgId)).toEqual(account);
    expect(await repository.reserve(actor.orgId)).toEqual({
      kind: 'existing',
      account,
    });
    await expect(repository.saveCreated(account)).rejects.toThrow('completed');
    const ready = {
      ...account,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsDue: [],
    };
    await repository.update(ready);
    expect(await repository.load(actor.orgId)).toEqual(ready);
    const stripeAccount = {
      id: account.stripeAccountId,
      orgId: actor.orgId,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirements: { currentlyDue: [], disabledReason: null },
    };
    const gateway = { retrieveAccount: () => Promise.resolve(stripeAccount) };
    expect(
      await resolveConnectAccountOrg(
        database,
        actor.actor.accountId,
        gateway,
        account.stripeAccountId,
      ),
    ).toBe(actor.orgId);
    await expect(
      resolveConnectAccountOrg(
        database,
        actor.actor.accountId,
        {
          retrieveAccount: () =>
            Promise.resolve({ ...stripeAccount, orgId: other.orgId }),
        },
        account.stripeAccountId,
      ),
    ).rejects.toThrow();
    const row = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('payment_accounts')
        .select(['onboarding_status', 'version'])
        .where('org_id', '=', actor.orgId)
        .executeTakeFirstOrThrow(),
    );
    expect(row.onboarding_status).toBe('active');
    expect(row.version).toBe(3);
    await repository.update(ready);
    const duplicate = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('payment_accounts')
        .select('version')
        .where('org_id', '=', actor.orgId)
        .executeTakeFirstOrThrow(),
    );
    expect(duplicate.version).toBe(3);
    const disabled = {
      ...stripeAccount,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: {
        currentlyDue: ['individual.verification.document'],
        disabledReason: 'requirements.past_due',
      },
    };
    const service = new ConnectAccountEventService(
      database,
      actor.actor.accountId,
      { retrieveAccount: () => Promise.resolve(disabled) },
    );
    const event = {
      id: 'evt_connect_repo',
      object: 'event' as const,
      type: 'account.updated',
      account: account.stripeAccountId,
      livemode: false,
      created: 1,
      data: { object: { id: account.stripeAccountId, object: 'account' } },
    };
    await service.handle(event);
    await service.handle(event);
    expect(await repository.load(actor.orgId)).toMatchObject({
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: ['individual.verification.document'],
      disabledReason: 'requirements.past_due',
    });
    const afterEvents = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('payment_accounts')
        .select('version')
        .where('org_id', '=', actor.orgId)
        .executeTakeFirstOrThrow(),
    );
    expect(afterEvents.version).toBe(4);
    await expect(
      service.handle({ ...event, account: 'acct_foreign' }),
    ).rejects.toThrow('does not match');
    await expect(
      repository.update({ ...ready, stripeAccountId: 'acct_foreign' }),
    ).rejects.toThrow('does not belong');
    await expect(repository.load(other.orgId)).rejects.toThrow('mismatch');
    const crossTenantRows = await createWithOrg(database)(other, (trx) =>
      trx
        .selectFrom('payment_accounts')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(crossTenantRows).toEqual([]);
  });
});
