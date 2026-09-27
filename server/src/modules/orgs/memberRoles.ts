import { newId } from '@shared/ids';
import {
  orgMemberRolesResponseSchema,
  updateOrgMemberRolesSchema,
} from '@shared/schemas/orgs';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import { revokeSessions } from '../auth/sessions';

export class OrgMemberRolesError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

export async function setOrgMemberRoles(
  database: Kysely<DB>,
  input: {
    orgId: string;
    actorId: string;
    targetId: string;
    changes: z.input<typeof updateOrgMemberRolesSchema>;
    now: Date;
  },
): Promise<z.output<typeof orgMemberRolesResponseSchema>> {
  const changes = updateOrgMemberRolesSchema.parse(input.changes);
  const withOrg = createWithOrg(database);
  return withOrg(
    { orgId: input.orgId, actor: { accountId: input.actorId } },
    async (trx) => {
      const org = await trx
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', input.orgId)
        .forUpdate()
        .executeTakeFirst();
      if (!org)
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Organization not found',
        );
      const actor = await trx
        .selectFrom('org_memberships')
        .innerJoin('role_assignments', (join) =>
          join
            .onRef('role_assignments.org_id', '=', 'org_memberships.org_id')
            .onRef(
              'role_assignments.account_id',
              '=',
              'org_memberships.account_id',
            ),
        )
        .select('org_memberships.id')
        .where('org_memberships.org_id', '=', input.orgId)
        .where('org_memberships.account_id', '=', input.actorId)
        .where('org_memberships.status', '=', 'active')
        .where('role_assignments.role', '=', 'owner')
        .where('role_assignments.scope_type', '=', 'org')
        .where('role_assignments.pending_mfa', '=', false)
        .where('role_assignments.revoked_at', 'is', null)
        .executeTakeFirst();
      if (!actor)
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Organization not found',
        );
      const member = await trx
        .selectFrom('org_memberships')
        .select(['id', 'version'])
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', input.targetId)
        .where('status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      if (!member)
        throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Member not found');
      if (member.version !== changes.expectedVersion)
        throw new OrgMemberRolesError(
          409,
          'CONFLICT',
          'Member changed; reload before saving',
        );
      const current = await trx
        .selectFrom('role_assignments')
        .select(['id', 'role', 'pending_mfa'])
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', input.targetId)
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .execute();
      const before = new Set(current.map((row) => row.role));
      const after = new Set<string>(changes.roles);
      if (after.has('owner') && !before.has('owner')) {
        throw new OrgMemberRolesError(
          403,
          'FORBIDDEN',
          'Ownership requires a recipient-accepted transfer',
        );
      }
      if (before.has('owner') && !after.has('owner')) {
        const activeOwners = await trx
          .selectFrom('role_assignments')
          .innerJoin('org_memberships', (join) =>
            join
              .onRef('org_memberships.org_id', '=', 'role_assignments.org_id')
              .onRef(
                'org_memberships.account_id',
                '=',
                'role_assignments.account_id',
              ),
          )
          .select('role_assignments.id')
          .where('role_assignments.org_id', '=', input.orgId)
          .where('role_assignments.role', '=', 'owner')
          .where('role_assignments.scope_type', '=', 'org')
          .where('role_assignments.pending_mfa', '=', false)
          .where('role_assignments.revoked_at', 'is', null)
          .where('org_memberships.status', '=', 'active')
          .execute();
        if (activeOwners.length <= 1) {
          throw new OrgMemberRolesError(
            409,
            'CONFLICT',
            'The last active owner cannot be removed',
          );
        }
      }
      const changed =
        before.size !== after.size ||
        [...before].some((role) => !after.has(role));
      if (!changed) {
        return orgMemberRolesResponseSchema.parse({
          accountId: input.targetId,
          roles: changes.roles,
          pendingMfa: current.some((row) => row.pending_mfa),
          version: member.version,
        });
      }
      const hasMfa = Boolean(
        await trx
          .selectFrom('mfa_factors')
          .select('id')
          .where('account_id', '=', input.targetId)
          .where('confirmed_at', 'is not', null)
          .executeTakeFirst(),
      );
      const removed = [...before].filter((role) => !after.has(role));
      if (removed.length > 0) {
        await trx
          .updateTable('role_assignments')
          .set({ revoked_at: input.now })
          .where('org_id', '=', input.orgId)
          .where('account_id', '=', input.targetId)
          .where('scope_type', '=', 'org')
          .where('role', 'in', removed)
          .where('revoked_at', 'is', null)
          .execute();
      }
      for (const role of changes.roles) {
        if (before.has(role)) continue;
        await trx
          .insertInto('role_assignments')
          .values({
            id: newId(),
            org_id: input.orgId,
            account_id: input.targetId,
            role,
            scope_type: 'org',
            granted_by: input.actorId,
            granted_at: input.now,
            pending_mfa: !hasMfa && ['admin', 'finance'].includes(role),
          })
          .execute();
      }
      await trx
        .updateTable('org_memberships')
        .set({ version: member.version + 1 })
        .where('id', '=', member.id)
        .execute();
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: input.orgId,
          actor_account_id: input.actorId,
          action: 'membership.roles_changed',
          entity_type: 'org_membership',
          entity_id: member.id,
          changes: { before: [...before].sort(), after: [...after].sort() },
        })
        .execute();
      await revokeSessions(trx, input.targetId, input.now);
      return orgMemberRolesResponseSchema.parse({
        accountId: input.targetId,
        roles: changes.roles,
        pendingMfa:
          current.some((row) => after.has(row.role) && row.pending_mfa) ||
          changes.roles.some(
            (role) =>
              !before.has(role) &&
              ['admin', 'finance'].includes(role) &&
              !hasMfa,
          ),
        version: member.version + 1,
      });
    },
  );
}
