import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { VersionConflictError } from '../../lib/version-check';

import { PlatformAccessError } from './service';
import type { PlatformRole, PlatformStaff } from './service';

let platformAdminDatabase: Kysely<DB> | undefined;
export function getPlatformAdminDatabase(): Kysely<DB> {
  platformAdminDatabase ??= createDatabase(
    process.env.DATABASE_ADMIN_URL ??
      'postgres://athlentry_admin@127.0.0.1:5432/athlentry_dev',
  );
  return platformAdminDatabase;
}

function requireSuperAdmin(actor: PlatformStaff): void {
  if (actor.role !== 'super_admin')
    throw new PlatformAccessError('Platform admin required');
}

export async function listPlans(database: Kysely<DB>) {
  const rows = await sql<{
    id: string;
    key: string;
    name: string;
    monthly_price_cents: number;
    application_fee_bps: number;
    application_fee_fixed_cents: number;
    limits: unknown;
    active: boolean;
    version: number;
  }>`SELECT id, key, name, monthly_price_cents, application_fee_bps,
      application_fee_fixed_cents, limits, active, version
      FROM plans ORDER BY name, id`.execute(database);
  return rows.rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    monthlyPriceCents: row.monthly_price_cents,
    applicationFeeBps: row.application_fee_bps,
    applicationFeeFixedCents: row.application_fee_fixed_cents,
    limits: row.limits,
    active: row.active,
    version: row.version,
  }));
}

export const planInputSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{1,49}$/),
  name: z.string().trim().min(1).max(100),
  monthlyPriceCents: z.number().int().nonnegative(),
  applicationFeeBps: z.number().int().min(0).max(10_000),
  applicationFeeFixedCents: z.number().int().nonnegative(),
  limits: z.record(z.string(), z.number().int().nonnegative()).default({}),
  active: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
});

export async function savePlan(
  database: Kysely<DB>,
  actor: PlatformStaff,
  id: string | null,
  rawInput: unknown,
) {
  requireSuperAdmin(actor);
  const input = planInputSchema.parse(rawInput);
  return database.transaction().execute(async (trx) => {
    const planId = id ?? randomUUID();
    const current = id
      ? await sql<{
          version: number;
        }>`SELECT version FROM plans WHERE id = ${id} FOR UPDATE`.execute(trx)
      : null;
    const version = current?.rows[0]?.version ?? 0;
    if (version !== input.expectedVersion)
      throw new VersionConflictError({ id: planId, version });
    if (id && version === 0)
      throw new PlatformAccessError('Plan not found', 404);
    if (id) {
      await sql`UPDATE plans SET key = ${input.key}, name = ${input.name},
        monthly_price_cents = ${input.monthlyPriceCents},
        application_fee_bps = ${input.applicationFeeBps},
        application_fee_fixed_cents = ${input.applicationFeeFixedCents},
        limits = ${JSON.stringify(input.limits)}::jsonb, active = ${input.active},
        version = version + 1 WHERE id = ${id}`.execute(trx);
    } else {
      await sql`INSERT INTO plans
        (id, key, name, monthly_price_cents, application_fee_bps,
          application_fee_fixed_cents, limits, active)
        VALUES (${planId}, ${input.key}, ${input.name}, ${input.monthlyPriceCents},
          ${input.applicationFeeBps}, ${input.applicationFeeFixedCents},
          ${JSON.stringify(input.limits)}::jsonb, ${input.active})`.execute(
        trx,
      );
    }
    await sql`INSERT INTO platform_audit_log
      (id, staff_account_id, action, details)
      VALUES (${randomUUID()}, ${actor.accountId}, ${id ? 'plan.update' : 'plan.create'},
        ${JSON.stringify({ planId, key: input.key, version: version + 1 })}::jsonb)`.execute(
      trx,
    );
    return { id: planId, version: version + 1 };
  });
}

export async function listFeatureFlags(database: Kysely<DB>) {
  const rows = await sql<{
    key: string;
    description: string;
    enabled: boolean;
    organization_overrides: unknown;
    version: number;
  }>`SELECT key, description, enabled, organization_overrides, version
      FROM platform_feature_flags ORDER BY key`.execute(database);
  return rows.rows.map((row) => ({
    key: row.key,
    description: row.description,
    enabled: row.enabled,
    organizationOverrides: row.organization_overrides,
    version: row.version,
  }));
}

export const featureFlagInputSchema = z.strictObject({
  description: z.string().trim().min(1).max(300),
  enabled: z.boolean(),
  organizationOverrides: z.record(z.uuid(), z.boolean()).default({}),
  expectedVersion: z.number().int().nonnegative(),
});

export async function saveFeatureFlag(
  database: Kysely<DB>,
  actor: PlatformStaff,
  key: string,
  rawInput: unknown,
) {
  requireSuperAdmin(actor);
  if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(key))
    throw new RangeError('Invalid feature flag key');
  const input = featureFlagInputSchema.parse(rawInput);
  return database.transaction().execute(async (trx) => {
    const current = await sql<{
      version: number;
    }>`SELECT version FROM platform_feature_flags
      WHERE key = ${key} FOR UPDATE`.execute(trx);
    const version = current.rows[0]?.version ?? 0;
    if (version !== input.expectedVersion)
      throw new VersionConflictError({ key, version });
    if (version) {
      await sql`UPDATE platform_feature_flags SET description = ${input.description},
        enabled = ${input.enabled}, organization_overrides = ${JSON.stringify(input.organizationOverrides)}::jsonb,
        version = version + 1 WHERE key = ${key}`.execute(trx);
    } else {
      await sql`INSERT INTO platform_feature_flags
        (key, description, enabled, organization_overrides)
        VALUES (${key}, ${input.description}, ${input.enabled},
          ${JSON.stringify(input.organizationOverrides)}::jsonb)`.execute(trx);
    }
    await sql`INSERT INTO platform_audit_log
      (id, staff_account_id, action, details)
      VALUES (${randomUUID()}, ${actor.accountId}, ${version ? 'feature_flag.update' : 'feature_flag.create'},
        ${JSON.stringify({ key, enabled: input.enabled, version: version + 1 })}::jsonb)`.execute(
      trx,
    );
    return { key, version: version + 1 };
  });
}

export async function listPlatformStaff(database: Kysely<DB>) {
  const rows = await sql<{
    account_id: string;
    email: string;
    first_name: string;
    last_name: string;
    role: PlatformRole;
    active: boolean;
  }>`SELECT s.account_id, a.email, a.first_name, a.last_name, s.role, s.active
      FROM platform_staff s JOIN accounts a ON a.id = s.account_id
      ORDER BY a.email`.execute(database);
  return rows.rows.map((row) => ({
    accountId: row.account_id,
    email: row.email,
    name: `${row.first_name} ${row.last_name}`,
    role: row.role,
    active: row.active,
  }));
}

export async function savePlatformStaff(
  database: Kysely<DB>,
  actor: PlatformStaff,
  accountId: string,
  input: { role: PlatformRole; active: boolean },
) {
  requireSuperAdmin(actor);
  return database.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('platform_staff_admin'))`.execute(
      trx,
    );
    const account = await sql<{
      id: string;
    }>`SELECT id FROM accounts WHERE id = ${accountId}`.execute(trx);
    if (!account.rows[0])
      throw new PlatformAccessError('Account not found', 404);
    const current = await sql<{ role: PlatformRole; active: boolean }>`
      SELECT role, active FROM platform_staff WHERE account_id = ${accountId} FOR UPDATE
    `.execute(trx);
    if (
      current.rows[0]?.role === 'super_admin' &&
      current.rows[0].active &&
      (input.role !== 'super_admin' || !input.active)
    ) {
      const count = await sql<{
        total: string;
      }>`SELECT count(*)::text AS total FROM platform_staff
        WHERE role = 'super_admin' AND active = true`.execute(trx);
      if (Number(count.rows[0]?.total ?? 0) <= 1)
        throw new RangeError(
          'The last active platform admin cannot be removed',
        );
    }
    await sql`INSERT INTO platform_staff(account_id, role, active)
      VALUES (${accountId}, ${input.role}, ${input.active})
      ON CONFLICT (account_id) DO UPDATE SET role = EXCLUDED.role,
        active = EXCLUDED.active`.execute(trx);
    await sql`INSERT INTO platform_audit_log
      (id, staff_account_id, action, target_account_id, details)
      VALUES (${randomUUID()}, ${actor.accountId}, 'platform_staff.update', ${accountId},
        ${JSON.stringify({ role: input.role, active: input.active })}::jsonb)`.execute(
      trx,
    );
    return { accountId, ...input };
  });
}
