import { randomUUID } from 'node:crypto';

import { createWithOrg } from '@server/db/withOrg';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';

import { createOrganization, OrgCreationError } from './create';

const accountId = randomUUID();
const now = new Date('2026-09-26T18:00:00Z');
const slug = `river-${randomUUID().slice(0, 8)}`;
let database: Kysely<DB>;

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO sport_templates (id, key, name, profile)
       VALUES ($1, 'test_sport', 'Test Sport', '{"rules":"safe"}'::jsonb)`,
      [randomUUID()],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `org-owner-${randomUUID()}@example.invalid`,
      email_verified_at: now,
      first_name: 'River',
      last_name: 'Owner',
      date_of_birth: '1990-01-01',
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

const input = {
  name: 'River Club',
  slug,
  kind: 'club' as const,
  timezone: 'America/Chicago',
  address: {
    line1: '1 Main Street',
    city: 'Chicago',
    region: 'IL',
    postalCode: '60601',
    country: 'US' as const,
  },
  sportKeys: ['test_sport'],
};

describe('organization bootstrap', () => {
  it('creates starter defaults and keeps every tenant read scoped', async () => {
    const created = await createOrganization(database, accountId, input, now);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toMatchObject({ slug, status: 'onboarding' });
    const org = await database
      .selectFrom('organizations')
      .select(['plan_id', 'application_fee_bps', 'settings'])
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(org.application_fee_bps).toBe(150);
    expect(org.plan_id).toBeTruthy();
    expect(org.settings).toMatchObject({ coachMedicalAccess: 'flags_only' });

    const withOrg = createWithOrg(database);
    const records = await withOrg(
      { orgId: created.id, actor: { accountId } },
      async (trx) => ({
        members: await trx
          .selectFrom('org_memberships')
          .select('account_id')
          .execute(),
        roles: await trx
          .selectFrom('role_assignments')
          .select(['role', 'pending_mfa'])
          .execute(),
        sports: await trx
          .selectFrom('sport_profiles')
          .select('template_key')
          .execute(),
        seasons: await trx
          .selectFrom('seasons')
          .select(['starts_on', 'ends_on'])
          .execute(),
        credentials: await trx
          .selectFrom('credential_types')
          .select('key')
          .execute(),
        forms: await trx
          .selectFrom('form_definitions')
          .select('name')
          .execute(),
        waivers: await trx
          .selectFrom('waiver_documents')
          .select(['template_unreviewed', 'published_at'])
          .execute(),
        audit: await trx.selectFrom('audit_log').select('action').execute(),
      }),
    );
    expect(records.members).toEqual([{ account_id: accountId }]);
    expect(records.roles).toEqual([{ role: 'owner', pending_mfa: true }]);
    expect(records.sports).toEqual([{ template_key: 'test_sport' }]);
    expect(records.seasons).toHaveLength(1);
    expect(records.credentials).toHaveLength(4);
    expect(records.forms).toHaveLength(2);
    expect(records.waivers).toEqual([
      { template_unreviewed: true, published_at: null },
    ]);
    expect(records.audit).toEqual([{ action: 'organization.created' }]);
    expect(
      await database.selectFrom('org_memberships').select('id').execute(),
    ).toEqual([]);
  });

  it('rolls back unsupported sports and reports a duplicate slug', async () => {
    const absentSlug = `invalid-${randomUUID().slice(0, 8)}`;
    await expect(
      createOrganization(
        database,
        accountId,
        {
          ...input,
          slug: absentSlug,
          sportKeys: ['unavailable'],
        },
        now,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    } satisfies Partial<OrgCreationError>);
    expect(
      await database
        .selectFrom('organizations')
        .select('id')
        .where('slug', '=', absentSlug)
        .executeTakeFirst(),
    ).toBeUndefined();
    await expect(
      createOrganization(database, accountId, input, now),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<OrgCreationError>);
  });
});
