import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

import { OrgMemberRolesError } from './memberRoles';

export async function getOrgWorkspace(
  database: Kysely<DB>,
  orgId: string,
  accountId: string,
) {
  return createWithOrg(database)(
    { orgId, actor: { accountId } },
    async (trx) => {
      const member = await trx
        .selectFrom('org_memberships')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', accountId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!member)
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Organization not found',
        );
      const org = await trx
        .selectFrom('organizations')
        .select(['id', 'name', 'slug'])
        .where('id', '=', orgId)
        .where('status', 'in', ['active', 'onboarding'])
        .executeTakeFirst();
      if (!org)
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Organization not found',
        );
      const roles = await trx
        .selectFrom('role_assignments')
        .select('role')
        .where('org_id', '=', orgId)
        .where('account_id', '=', accountId)
        .where('scope_type', '=', 'org')
        .where('pending_mfa', '=', false)
        .where('revoked_at', 'is', null)
        .execute();
      const names = new Set(roles.map((role) => role.role));
      return {
        ...org,
        canManage: names.has('owner'),
        canAudit: names.has('owner') || names.has('admin'),
      };
    },
  );
}
