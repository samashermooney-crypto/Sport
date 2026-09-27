import { newId } from '@shared/ids';
import {
  ownershipTransferAcceptResponseSchema,
  ownershipTransferRequestResponseSchema,
} from '@shared/schemas/orgs';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import { z as zod } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { revokeSessions } from '../auth/sessions';
import { consumeAuthToken, issueAuthToken } from '../auth/tokens';

import { OrgMemberRolesError } from './memberRoles';

export async function requestOwnershipTransfer(
  dependencies: { database: Kysely<DB>; email: EmailSender; appUrl: string },
  input: {
    orgId: string;
    actorId: string;
    recipientAccountId: string;
    expectedVersion: number;
    now: Date;
  },
): Promise<z.output<typeof ownershipTransferRequestResponseSchema>> {
  if (input.actorId === input.recipientAccountId)
    throw new OrgMemberRolesError(409, 'CONFLICT', 'Choose another member');
  const withOrg = createWithOrg(dependencies.database);
  const result = await withOrg(
    { orgId: input.orgId, actor: { accountId: input.actorId } },
    async (trx) => {
      await trx
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', input.orgId)
        .forUpdate()
        .executeTakeFirstOrThrow();
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
        .select(['org_memberships.version', 'org_memberships.status'])
        .where('org_memberships.org_id', '=', input.orgId)
        .where('org_memberships.account_id', '=', input.actorId)
        .where('role_assignments.role', '=', 'owner')
        .where('role_assignments.scope_type', '=', 'org')
        .where('role_assignments.pending_mfa', '=', false)
        .where('role_assignments.revoked_at', 'is', null)
        .executeTakeFirst();
      if (!actor || actor.status !== 'active')
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Organization not found',
        );
      if (actor.version !== input.expectedVersion)
        throw new OrgMemberRolesError(
          409,
          'CONFLICT',
          'Owner changed; reload before transferring',
        );
      const recipient = await trx
        .selectFrom('org_memberships')
        .innerJoin('accounts', 'accounts.id', 'org_memberships.account_id')
        .select([
          'org_memberships.version',
          'org_memberships.status',
          'accounts.email',
          'accounts.email_verified_at',
        ])
        .where('org_memberships.org_id', '=', input.orgId)
        .where('org_memberships.account_id', '=', input.recipientAccountId)
        .executeTakeFirst();
      if (
        !recipient ||
        recipient.status !== 'active' ||
        !recipient.email_verified_at
      )
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Recipient must be an active member',
        );
      const alreadyOwner = await trx
        .selectFrom('role_assignments')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', input.recipientAccountId)
        .where('role', '=', 'owner')
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (alreadyOwner)
        throw new OrgMemberRolesError(
          409,
          'CONFLICT',
          'Recipient is already an owner',
        );
      const token = await issueAuthToken(
        trx,
        {
          purpose: 'ownership_transfer',
          email: recipient.email,
          accountId: input.recipientAccountId,
          orgId: input.orgId,
          subjectKey: input.actorId,
          payload: {
            fromId: input.actorId,
            toId: input.recipientAccountId,
            fromVersion: actor.version,
            toVersion: recipient.version,
          },
          createdBy: input.actorId,
        },
        input.now,
      );
      const record = await trx
        .selectFrom('auth_tokens')
        .select(['id', 'expires_at'])
        .where('purpose', '=', 'ownership_transfer')
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', input.recipientAccountId)
        .where('subject_key', '=', input.actorId)
        .where('consumed_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: input.orgId,
          actor_account_id: input.actorId,
          action: 'membership.ownership_transfer_requested',
          entity_type: 'auth_token',
          entity_id: record.id,
          changes: { recipientAccountId: input.recipientAccountId },
        })
        .execute();
      return {
        token,
        email: recipient.email,
        tokenId: record.id,
        response: ownershipTransferRequestResponseSchema.parse({
          recipientAccountId: input.recipientAccountId,
          expiresAt: record.expires_at.toISOString(),
        }),
      };
    },
  );
  try {
    await dependencies.email.send({
      to: result.email,
      subject: 'Accept Athlentry organization ownership',
      text: `An organization owner has requested to transfer ownership to you. Open ${dependencies.appUrl}/ownership-transfer/${input.orgId}/${result.token} while signed in to accept. This link expires in 24 hours.`,
      kind: 'security',
      idempotencyKey: result.tokenId,
    });
  } catch (error) {
    await withOrg(
      { orgId: input.orgId, actor: { accountId: input.actorId } },
      (trx) =>
        trx
          .updateTable('auth_tokens')
          .set({ revoked_at: input.now })
          .where('id', '=', result.tokenId)
          .execute()
          .then(() => undefined),
    );
    throw error;
  }
  return result.response;
}

export async function acceptOwnershipTransfer(
  database: Kysely<DB>,
  input: { orgId: string; recipientId: string; token: string; now: Date },
): Promise<z.output<typeof ownershipTransferAcceptResponseSchema>> {
  return createWithOrg(database)(
    { orgId: input.orgId, actor: { accountId: input.recipientId } },
    async (trx) => {
      await trx
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', input.orgId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const token = await consumeAuthToken(
        trx,
        'ownership_transfer',
        input.token,
        input.now,
      );
      if (
        !token ||
        token.orgId !== input.orgId ||
        token.accountId !== input.recipientId
      )
        throw new OrgMemberRolesError(
          404,
          'NOT_FOUND',
          'Transfer not found or expired',
        );
      const fromId = zod.uuid().parse(token.payload.fromId);
      const toId = zod.uuid().parse(token.payload.toId);
      const fromVersion = zod
        .number()
        .int()
        .positive()
        .parse(token.payload.fromVersion);
      const toVersion = zod
        .number()
        .int()
        .positive()
        .parse(token.payload.toVersion);
      if (toId !== input.recipientId)
        throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Transfer not found');
      const account = await trx
        .selectFrom('accounts')
        .select('email')
        .where('id', '=', input.recipientId)
        .executeTakeFirst();
      if (!account || account.email.toLowerCase() !== token.email.toLowerCase())
        throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Transfer not found');
      const from = await trx
        .selectFrom('org_memberships')
        .select(['id', 'version', 'status'])
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', fromId)
        .executeTakeFirst();
      const to = await trx
        .selectFrom('org_memberships')
        .select(['id', 'version', 'status'])
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', toId)
        .executeTakeFirst();
      if (
        !from ||
        !to ||
        from.status !== 'active' ||
        to.status !== 'active' ||
        from.version !== fromVersion ||
        to.version !== toVersion
      )
        throw new OrgMemberRolesError(
          409,
          'CONFLICT',
          'Membership changed; request a new transfer',
        );
      const hasMfa = await trx
        .selectFrom('mfa_factors')
        .select('id')
        .where('account_id', '=', toId)
        .where('confirmed_at', 'is not', null)
        .executeTakeFirst();
      if (!hasMfa)
        throw new OrgMemberRolesError(
          403,
          'FORBIDDEN',
          'Enroll MFA before accepting ownership',
        );
      const owner = await trx
        .selectFrom('role_assignments')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', fromId)
        .where('role', '=', 'owner')
        .where('scope_type', '=', 'org')
        .where('pending_mfa', '=', false)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!owner)
        throw new OrgMemberRolesError(409, 'CONFLICT', 'Current owner changed');
      const recipientOwner = await trx
        .selectFrom('role_assignments')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', toId)
        .where('role', '=', 'owner')
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (recipientOwner)
        throw new OrgMemberRolesError(
          409,
          'CONFLICT',
          'Recipient is already an owner',
        );
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: input.orgId,
          account_id: toId,
          role: 'owner',
          scope_type: 'org',
          granted_by: fromId,
          granted_at: input.now,
          pending_mfa: false,
        })
        .execute();
      await trx
        .updateTable('role_assignments')
        .set({ revoked_at: input.now })
        .where('id', '=', owner.id)
        .execute();
      await trx
        .updateTable('org_memberships')
        .set({ version: from.version + 1 })
        .where('id', '=', from.id)
        .execute();
      await trx
        .updateTable('org_memberships')
        .set({ version: to.version + 1 })
        .where('id', '=', to.id)
        .execute();
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: input.orgId,
          actor_account_id: toId,
          action: 'membership.ownership_transferred',
          entity_type: 'org_membership',
          entity_id: to.id,
          changes: { previousOwnerId: fromId, ownerId: toId },
        })
        .execute();
      await revokeSessions(trx, fromId, input.now);
      await revokeSessions(trx, toId, input.now);
      return ownershipTransferAcceptResponseSchema.parse({
        orgId: input.orgId,
        previousOwnerId: fromId,
        ownerId: toId,
      });
    },
  );
}
