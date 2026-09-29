import type { OrgTransaction } from '../../db/withOrg';

export class WebsiteError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

export async function requireWebsiteEditor(
  trx: OrgTransaction,
  orgId: string,
  accountId: string,
): Promise<void> {
  const membership = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', orgId)
    .where('account_id', '=', accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!membership)
    throw new WebsiteError(404, 'NOT_FOUND', 'Website not found');

  const roles = await trx
    .selectFrom('role_assignments')
    .select('role')
    .where('org_id', '=', orgId)
    .where('account_id', '=', accountId)
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  if (
    !roles.some(({ role }) =>
      ['owner', 'admin', 'communications', 'director'].includes(role),
    )
  )
    throw new WebsiteError(403, 'FORBIDDEN', 'Website editor access required');
}
