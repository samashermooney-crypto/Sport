import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from './kysely';
import { allocateOrgNumber } from './orgCounters';
import type { DB } from './types';
import { createWithOrg } from './withOrg';

const orgA = randomUUID();
const orgB = randomUUID();
const actorA = randomUUID();
const actorB = randomUUID();
const contextA = { orgId: orgA, actor: { accountId: actorA } };
const contextB = { orgId: orgB, actor: { accountId: actorB } };

let appDb: Kysely<DB>;
let withOrg: ReturnType<typeof createWithOrg>;

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO organizations (id, slug, name, kind, timezone)
       VALUES ($1, 'org-a', 'Org A', 'club', 'America/Chicago'),
              ($2, 'org-b', 'Org B', 'club', 'America/Chicago')`,
      [orgA, orgB],
    );
  } finally {
    await admin.end();
  }
  appDb = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(appDb);
});

afterAll(async () => {
  await appDb.destroy();
});

describe('tenant database isolation', () => {
  it('enables and forces RLS on every table with org_id', async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      const result = await admin.query<{
        table_name: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policy_count: string;
        nullable: string;
      }>(`
        SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity,
               count(p.polname)::text AS policy_count,
               max(a.attnotnull::int)::text AS nullable
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE c.relkind IN ('r', 'p')
        GROUP BY c.oid
        ORDER BY c.relname
      `);
      expect(result.rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining([
          'audit_log',
          'auth_tokens',
          'idempotency_keys',
          'org_counters',
          'org_memberships',
          'role_assignments',
          'sport_profiles',
          'seasons',
          'credential_types',
          'form_definitions',
          'waiver_documents',
        ]),
      );
      for (const row of result.rows) {
        expect(row.relrowsecurity, row.table_name).toBe(true);
        expect(row.relforcerowsecurity, row.table_name).toBe(true);
        expect(Number(row.policy_count), row.table_name).toBeGreaterThan(0);
        if (
          !['audit_log', 'auth_tokens', 'credential_types'].includes(
            row.table_name,
          )
        ) {
          expect(row.nullable, row.table_name).toBe('1');
        }
      }
      const role = await admin.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'athlentry_app'",
      );
      expect(role.rows[0]?.rolbypassrls).toBe(false);
    } finally {
      await admin.end();
    }
  });

  it('hides tenant rows without context and across orgs', async () => {
    const user = await sql<{
      current_user: string;
    }>`select current_user`.execute(appDb);
    expect(user.rows[0]?.current_user).toBe('athlentry_app');

    await withOrg(contextA, async (trx) => {
      await trx
        .insertInto('idempotency_keys')
        .values({
          id: randomUUID(),
          org_id: orgA,
          actor_id: actorA,
          key: randomUUID(),
          request_hash: Buffer.alloc(32),
        })
        .execute();
    });
    await withOrg(contextB, async (trx) => {
      await trx
        .insertInto('idempotency_keys')
        .values({
          id: randomUUID(),
          org_id: orgB,
          actor_id: actorB,
          key: randomUUID(),
          request_hash: Buffer.alloc(32),
        })
        .execute();
    });

    expect(
      await appDb.selectFrom('idempotency_keys').selectAll().execute(),
    ).toEqual([]);
    const rowsA = await withOrg(contextA, (trx) =>
      trx.selectFrom('idempotency_keys').select('org_id').execute(),
    );
    expect(rowsA).toEqual([{ org_id: orgA }]);
    const rowsB = await withOrg(contextB, (trx) =>
      trx.selectFrom('idempotency_keys').select('org_id').execute(),
    );
    expect(rowsB).toEqual([{ org_id: orgB }]);

    await expect(
      withOrg(contextA, (trx) =>
        trx
          .insertInto('idempotency_keys')
          .values({
            id: randomUUID(),
            org_id: orgB,
            actor_id: actorA,
            key: randomUUID(),
            request_hash: Buffer.alloc(32),
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('allocates independent per-org numbers within transactions', async () => {
    expect(
      await withOrg(contextA, (trx) => allocateOrgNumber(trx, orgA, 'invoice')),
    ).toBe(1);
    expect(
      await withOrg(contextA, (trx) => allocateOrgNumber(trx, orgA, 'invoice')),
    ).toBe(2);
    expect(
      await withOrg(contextB, (trx) => allocateOrgNumber(trx, orgB, 'invoice')),
    ).toBe(1);
    const simultaneous = await Promise.all([
      withOrg(contextA, (trx) => allocateOrgNumber(trx, orgA, 'invoice')),
      withOrg(contextA, (trx) => allocateOrgNumber(trx, orgA, 'invoice')),
    ]);
    expect(simultaneous.sort()).toEqual([3, 4]);
  });

  it('sets updated_at in the database and leaves audit entries append-only', async () => {
    const keyId = randomUUID();
    await withOrg(contextA, async (trx) => {
      await trx
        .insertInto('idempotency_keys')
        .values({
          id: keyId,
          org_id: orgA,
          actor_id: actorA,
          key: randomUUID(),
          request_hash: Buffer.alloc(32),
        })
        .execute();
      const updated = await trx
        .updateTable('idempotency_keys')
        .set({ updated_at: new Date('2000-01-01T00:00:00Z') })
        .where('id', '=', keyId)
        .returning('updated_at')
        .executeTakeFirstOrThrow();
      expect(updated.updated_at.getFullYear()).toBeGreaterThan(2020);
      await trx
        .insertInto('audit_log')
        .values({
          id: randomUUID(),
          org_id: orgA,
          actor_account_id: actorA,
          action: 'test.audit',
          entity_type: 'test',
        })
        .execute();
    });
    await expect(
      withOrg(contextA, (trx) =>
        trx.updateTable('audit_log').set({ action: 'tampered' }).execute(),
      ),
    ).rejects.toThrow();
  });

  it('keeps the default waiver private until its draft text is replaced', async () => {
    const id = randomUUID();
    await withOrg(contextA, async (trx) => {
      await trx
        .insertInto('waiver_documents')
        .values({
          id,
          org_id: orgA,
          name: 'Default waiver',
          body_html: '<p>Draft — replace with your own reviewed text</p>',
          requires: 'guardian_if_minor',
          renewal: 'every_registration',
          template_unreviewed: true,
        })
        .execute();
    });
    expect(
      await withOrg(contextB, (trx) =>
        trx
          .selectFrom('waiver_documents')
          .select('id')
          .where('id', '=', id)
          .execute(),
      ),
    ).toEqual([]);
    await expect(
      withOrg(contextA, (trx) =>
        trx
          .updateTable('waiver_documents')
          .set({ published_at: new Date() })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      withOrg(contextA, (trx) =>
        trx
          .updateTable('waiver_documents')
          .set({ template_unreviewed: false })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toThrow();
    const reviewed = await withOrg(contextA, (trx) =>
      trx
        .updateTable('waiver_documents')
        .set({
          body_html: '<p>Organization reviewed text</p>',
          template_unreviewed: false,
        })
        .where('id', '=', id)
        .returning('template_unreviewed')
        .executeTakeFirstOrThrow(),
    );
    expect(reviewed.template_unreviewed).toBe(false);
  });
});
