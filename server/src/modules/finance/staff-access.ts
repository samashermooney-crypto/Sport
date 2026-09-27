import type { Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

export class FinanceAccessError extends Error {
  readonly status = 403;
  constructor() {
    super('Finance access is required');
    this.name = 'FinanceAccessError';
  }
}

export class FinanceResourceNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Finance resource not found');
    this.name = 'FinanceResourceNotFoundError';
  }
}

export async function requireFinanceStaff(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<void> {
  const result = await createWithOrg(database)(context, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!membership) return { member: false, allowed: false };
    const role = await trx
      .selectFrom('role_assignments')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('role', 'in', ['owner', 'admin', 'finance'])
      .where('scope_type', '=', 'org')
      .where('pending_mfa', '=', false)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return { member: true, allowed: Boolean(role) };
  });
  if (!result.member) throw new FinanceResourceNotFoundError();
  if (!result.allowed) throw new FinanceAccessError();
}

/** Platform subscription changes are reserved for an active org owner. */
export async function requireBillingOwner(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<void> {
  const result = await createWithOrg(database)(context, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!membership) return { member: false, allowed: false };
    const owner = await trx
      .selectFrom('role_assignments')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('role', '=', 'owner')
      .where('scope_type', '=', 'org')
      .where('pending_mfa', '=', false)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return { member: true, allowed: Boolean(owner) };
  });
  if (!result.member) throw new FinanceResourceNotFoundError();
  if (!result.allowed) throw new FinanceAccessError();
}

/** Aid decisions expose Restricted household finances to owner/finance only. */
export async function requireAidStaff(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<void> {
  const result = await createWithOrg(database)(context, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!membership) return { member: false, allowed: false };
    const role = await trx
      .selectFrom('role_assignments')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('role', 'in', ['owner', 'finance'])
      .where('scope_type', '=', 'org')
      .where('pending_mfa', '=', false)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return { member: true, allowed: Boolean(role) };
  });
  if (!result.member) throw new FinanceResourceNotFoundError();
  if (!result.allowed) throw new FinanceAccessError();
}
