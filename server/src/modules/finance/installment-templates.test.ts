import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import {
  PostgresInstallmentTemplates,
  type InstallmentTemplateInput,
} from './installment-templates.js';

let database: Kysely<DB>;
let context: OrgContext;

const input: InstallmentTemplateInput = {
  name: 'Three monthly payments',
  deposit: { kind: 'percent', bps: 2500 },
  schedule: { kind: 'monthly', count: 3, dayOfMonth: 15 },
  minAmountCents: 100,
  autopayRequired: true,
  allowedMethods: ['card', 'us_bank_account'],
};

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `template-${randomUUID()}@example.invalid`,
      first_name: 'Template',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `template-${randomUUID().slice(0, 12)}`,
      name: 'Template Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
});

afterAll(async () => {
  await database.destroy();
});

describe('versioned installment templates', () => {
  it('creates, replaces and archives with exact versions and an audit trail', async () => {
    const repo = new PostgresInstallmentTemplates(database, context);
    const first = await repo.create(input);
    expect(first).toMatchObject({ ...input, version: 1, active: true });
    expect(await repo.list(true)).toContainEqual(first);
    const changed = await repo.replace(first.id, first.version, {
      ...input,
      name: 'Updated monthly plan',
    });
    expect(changed.version).toBe(2);
    await expect(repo.replace(first.id, 1, input)).rejects.toThrow('changed');
    await repo.archive(first.id, changed.version);
    expect(await repo.list(true)).toEqual([]);
    expect((await repo.list(false))[0]).toMatchObject({
      active: false,
      version: 3,
    });
    const count = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('audit_log')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('entity_type', '=', 'installment_template')
        .execute(),
    );
    expect(count).toHaveLength(3);
  });

  it('rejects duplicate methods and unsorted dates', async () => {
    const repo = new PostgresInstallmentTemplates(database, context);
    await expect(
      repo.create({ ...input, allowedMethods: ['card', 'card'] }),
    ).rejects.toThrow('Duplicate');
    await expect(
      repo.create({
        ...input,
        schedule: {
          kind: 'fixed_dates',
          dates: ['2027-05-01', '2027-04-01'],
        },
      }),
    ).rejects.toThrow('strictly increasing');
  });

  it('persists and replaces a weekly template without losing its schedule', async () => {
    const repo = new PostgresInstallmentTemplates(database, context);
    const created = await repo.create({
      ...input,
      name: 'Weekly plan',
      schedule: { kind: 'weekly', count: 4 },
    });
    expect(created.schedule).toEqual({ kind: 'weekly', count: 4 });
    expect((await repo.list(true))[0]?.schedule).toEqual({
      kind: 'weekly',
      count: 4,
    });
    const replaced = await repo.replace(created.id, created.version, {
      ...input,
      name: 'Short weekly plan',
      schedule: { kind: 'weekly', count: 2 },
    });
    expect(replaced).toMatchObject({
      version: 2,
      schedule: { kind: 'weekly', count: 2 },
    });
    await repo.archive(replaced.id, replaced.version);
  });
});
