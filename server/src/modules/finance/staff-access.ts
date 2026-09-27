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

export async function requireFinanceStaff(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<void> {
  const allowed = await createWithOrg(database)(context, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!membership) return false;
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
    return Boolean(role);
  });
  if (!allowed) throw new FinanceAccessError();
}
