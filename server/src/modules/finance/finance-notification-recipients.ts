import type { OrgTransaction } from '../../db/withOrg.js';

/** Finance inbox recipients must still hold an active org role and membership. */
export async function activeFinanceNotificationRecipients(
  trx: OrgTransaction,
  orgId: string,
): Promise<string[]> {
  const staff = await trx
    .selectFrom('role_assignments as role')
    .innerJoin('org_memberships as member', (join) =>
      join
        .onRef('member.org_id', '=', 'role.org_id')
        .onRef('member.account_id', '=', 'role.account_id'),
    )
    .select('role.account_id')
    .distinct()
    .where('role.org_id', '=', orgId)
    .where('role.role', 'in', ['owner', 'admin', 'finance'])
    .where('role.scope_type', '=', 'org')
    .where('role.revoked_at', 'is', null)
    .where('role.pending_mfa', '=', false)
    .where('member.status', '=', 'active')
    .execute();
  return staff.map((member) => member.account_id);
}
