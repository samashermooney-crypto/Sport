import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import { decodeCursor, pageFromRows } from '../../lib/pagination';
import { VersionConflictError } from '../../lib/version-check';
import type { ActiveSession } from '../auth/sessions';

export type PlatformRole = 'super_admin' | 'support' | 'finance_ops';
export type PlatformStaff = { accountId: string; role: PlatformRole };

export class PlatformAccessError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
    this.code = status === 404 ? 'NOT_FOUND' : 'FORBIDDEN';
  }
}

export async function requirePlatformStaff(
  database: Kysely<DB>,
  session: ActiveSession,
  allowed: readonly PlatformRole[],
): Promise<PlatformStaff> {
  if (!session.mfaVerifiedAt)
    throw new PlatformAccessError('Platform staff must enroll in MFA');
  const result = await sql<{ account_id: string; role: PlatformRole }>`
    SELECT account_id, role FROM platform_staff
    WHERE account_id = ${session.accountId} AND active = true
  `.execute(database);
  const row = result.rows[0];
  if (!row || !allowed.includes(row.role))
    throw new PlatformAccessError('Platform access denied');
  return { accountId: row.account_id, role: row.role };
}

async function auditPlatform(
  trx: Kysely<DB> | Transaction<DB>,
  actor: PlatformStaff,
  action: string,
  options: {
    organizationId?: string;
    accountId?: string;
    impersonationId?: string;
    details?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO platform_audit_log
      (id, staff_account_id, action, target_organization_id, target_account_id, impersonation_id, details)
    VALUES (${randomUUID()}, ${actor.accountId}, ${action}, ${options.organizationId ?? null},
      ${options.accountId ?? null}, ${options.impersonationId ?? null},
      ${JSON.stringify(options.details ?? {})}::jsonb)
  `.execute(trx);
}

export async function listOrganizations(
  database: Kysely<DB>,
  input: { limit: number; cursor?: string; search?: string },
) {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 200
  )
    throw new RangeError('Organization page limit must be 1–200');
  let query = database
    .selectFrom('organizations')
    .leftJoin('plans', 'plans.id', 'organizations.plan_id')
    .select([
      'organizations.id',
      'organizations.slug',
      'organizations.name',
      'organizations.kind',
      'organizations.status',
      'organizations.version',
      'organizations.created_at',
      'plans.name as plan_name',
    ]);
  if (input.search) {
    const term = `%${input.search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    query = query.where((expression) =>
      expression.or([
        expression('organizations.name', 'ilike', term),
        expression('organizations.slug', 'ilike', term),
      ]),
    );
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, 'created_at');
    const date = new Date(String(cursor.value));
    if (Number.isNaN(date.valueOf()))
      throw new RangeError('Invalid organization cursor');
    query = query.where((expression) =>
      expression.or([
        expression('organizations.created_at', '<', date),
        expression.and([
          expression('organizations.created_at', '=', date),
          expression('organizations.id', '<', cursor.id),
        ]),
      ]),
    );
  }
  const rows = await query
    .orderBy('organizations.created_at', 'desc')
    .orderBy('organizations.id', 'desc')
    .limit(input.limit + 1)
    .execute();
  const page = pageFromRows(rows, input.limit, (row) => ({
    sort: 'created_at',
    value: row.created_at.toISOString(),
    id: row.id,
  }));
  return {
    items: page.items.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      status: row.status,
      version: row.version,
      planName: row.plan_name,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

export async function getOrganization(
  database: Kysely<DB>,
  actor: PlatformStaff,
  orgId: string,
) {
  return createWithOrg(database)({ orgId, actor }, async (trx) => {
    const org = await trx
      .selectFrom('organizations')
      .leftJoin('plans', 'plans.id', 'organizations.plan_id')
      .select([
        'organizations.id',
        'organizations.slug',
        'organizations.name',
        'organizations.kind',
        'organizations.status',
        'organizations.version',
        'organizations.plan_id',
        'organizations.application_fee_bps',
        'organizations.application_fee_fixed_cents',
        'organizations.created_at',
        'plans.name as plan_name',
      ])
      .where('organizations.id', '=', orgId)
      .executeTakeFirst();
    if (!org) throw new PlatformAccessError('Organization not found', 404);
    const payment = await trx
      .selectFrom('payment_accounts')
      .select([
        'onboarding_status',
        'charges_enabled',
        'payouts_enabled',
        'details_submitted',
      ])
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      kind: org.kind,
      status: org.status,
      version: org.version,
      planId: org.plan_id,
      planName: org.plan_name,
      applicationFeeBps: org.application_fee_bps,
      applicationFeeFixedCents: org.application_fee_fixed_cents,
      stripe: payment
        ? {
            onboardingStatus: payment.onboarding_status,
            chargesEnabled: payment.charges_enabled,
            payoutsEnabled: payment.payouts_enabled,
            detailsSubmitted: payment.details_submitted,
          }
        : null,
      createdAt: org.created_at.toISOString(),
    };
  });
}

export async function setOrganizationStatus(
  database: Kysely<DB>,
  actor: PlatformStaff,
  orgId: string,
  input: { status: 'active' | 'suspended'; expectedVersion: number },
) {
  if (actor.role !== 'super_admin')
    throw new PlatformAccessError('Platform admin required');
  return createWithOrg(database)({ orgId, actor }, async (trx) => {
    const current = await trx
      .selectFrom('organizations')
      .select(['id', 'status', 'version'])
      .where('id', '=', orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new PlatformAccessError('Organization not found', 404);
    if (current.version !== input.expectedVersion)
      throw new VersionConflictError(current);
    if (!['active', 'suspended'].includes(current.status))
      throw new RangeError(
        'Only active or suspended organizations can change status',
      );
    if (current.status === input.status)
      return { status: input.status, version: current.version };
    await trx
      .updateTable('organizations')
      .set({ status: input.status, version: current.version + 1 })
      .where('id', '=', orgId)
      .execute();
    await auditPlatform(trx, actor, 'organization.status_change', {
      organizationId: orgId,
      details: { before: current.status, after: input.status },
    });
    return { status: input.status, version: current.version + 1 };
  });
}

export async function setOrganizationPlan(
  database: Kysely<DB>,
  actor: PlatformStaff,
  orgId: string,
  input: { planId: string; expectedVersion: number },
) {
  if (actor.role !== 'super_admin')
    throw new PlatformAccessError('Platform admin required');
  return createWithOrg(database)({ orgId, actor }, async (trx) => {
    const current = await trx
      .selectFrom('organizations')
      .select(['id', 'plan_id', 'version'])
      .where('id', '=', orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new PlatformAccessError('Organization not found', 404);
    if (current.version !== input.expectedVersion)
      throw new VersionConflictError(current);
    const plan = await trx
      .selectFrom('plans')
      .select('id')
      .where('id', '=', input.planId)
      .where('active', '=', true)
      .executeTakeFirst();
    if (!plan) throw new PlatformAccessError('Plan not found', 404);
    await trx
      .updateTable('organizations')
      .set({ plan_id: plan.id, version: current.version + 1 })
      .where('id', '=', orgId)
      .execute();
    await auditPlatform(trx, actor, 'organization.plan_change', {
      organizationId: orgId,
      details: { before: current.plan_id, after: plan.id },
    });
    return { planId: plan.id, version: current.version + 1 };
  });
}
