import { newId } from '@shared/ids';
import {
  acceptedOrgInvitationResponseSchema,
  orgInvitationResponseSchema,
  orgInvitationSchema,
  orgStaffResponseSchema,
} from '@shared/schemas/orgs';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB, Json } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { idempotencyHash, parseIdempotencyKey } from '../../lib/idempotency';
import { consumeAuthToken, issueAuthToken } from '../auth/tokens';

import { OrgMemberRolesError } from './memberRoles';

type Invitation = z.output<typeof orgInvitationSchema>;
type InvitationResponse = z.output<typeof orgInvitationResponseSchema>;

export async function listOrgStaff(
  database: Kysely<DB>,
  input: { orgId: string; actorId: string; now: Date },
): Promise<z.output<typeof orgStaffResponseSchema>> {
  return createWithOrg(database)(
    { orgId: input.orgId, actor: { accountId: input.actorId } },
    async (trx) => {
      await assertActiveOwner(trx, input.orgId, input.actorId);
      const members = await trx
        .selectFrom('org_memberships')
        .innerJoin('accounts', 'accounts.id', 'org_memberships.account_id')
        .select([
          'org_memberships.account_id',
          'org_memberships.status',
          'org_memberships.version',
          'accounts.email',
          'accounts.first_name',
          'accounts.last_name',
        ])
        .where('org_memberships.org_id', '=', input.orgId)
        .where('org_memberships.status', '!=', 'removed')
        .orderBy('accounts.email')
        .execute();
      const roles = await trx
        .selectFrom('role_assignments')
        .select(['account_id', 'role', 'scope_type', 'scope_id', 'pending_mfa'])
        .where('org_id', '=', input.orgId)
        .where('revoked_at', 'is', null)
        .orderBy('role')
        .execute();
      const invitations = await trx
        .selectFrom('auth_tokens')
        .select(['id', 'email', 'payload', 'expires_at'])
        .where('org_id', '=', input.orgId)
        .where('purpose', '=', 'org_invitation')
        .where('consumed_at', 'is', null)
        .where('revoked_at', 'is', null)
        .orderBy('created_at', 'desc')
        .execute();
      const seasons = await trx
        .selectFrom('seasons')
        .select(['id', 'name'])
        .where('org_id', '=', input.orgId)
        .orderBy('name')
        .execute();
      const programs = await trx
        .selectFrom('programs')
        .select(['id', 'name'])
        .where('org_id', '=', input.orgId)
        .orderBy('name')
        .execute();
      const divisions = await trx
        .selectFrom('divisions')
        .select(['id', 'name'])
        .where('org_id', '=', input.orgId)
        .orderBy('name')
        .execute();
      const teams = await trx
        .selectFrom('team_seasons')
        .innerJoin('teams', (join) =>
          join
            .onRef('teams.org_id', '=', 'team_seasons.org_id')
            .onRef('teams.id', '=', 'team_seasons.team_id'),
        )
        .select(['team_seasons.id', 'teams.name', 'team_seasons.display_name'])
        .where('team_seasons.org_id', '=', input.orgId)
        .orderBy('teams.name')
        .execute();
      return orgStaffResponseSchema.parse({
        scopes: [
          ...seasons.map((item) => ({
            id: item.id,
            name: item.name,
            scopeType: 'season',
          })),
          ...programs.map((item) => ({
            id: item.id,
            name: item.name,
            scopeType: 'program',
          })),
          ...divisions.map((item) => ({
            id: item.id,
            name: item.name,
            scopeType: 'division',
          })),
          ...teams.map((item) => ({
            id: item.id,
            name: item.display_name ?? item.name,
            scopeType: 'team_season',
          })),
        ],
        members: members.map((member) => ({
          accountId: member.account_id,
          email: member.email,
          name: `${member.first_name} ${member.last_name}`,
          status: member.status,
          version: member.version,
          roles: roles
            .filter((role) => role.account_id === member.account_id)
            .map((role) => ({
              role: role.role,
              scopeType: role.scope_type,
              scopeId: role.scope_id,
              pendingMfa: role.pending_mfa,
            })),
        })),
        invitations: invitations.map((item) => {
          const invitation = orgInvitationSchema.parse({
            email: item.email,
            roles: (item.payload as Record<string, unknown>).roles,
            scopeType: (item.payload as Record<string, unknown>).scopeType,
            scopeId: (item.payload as Record<string, unknown>).scopeId,
          });
          return {
            id: item.id,
            email: item.email,
            roles: invitation.roles,
            scopeType: invitation.scopeType,
            scopeId: invitation.scopeId,
            expiresAt: item.expires_at.toISOString(),
          };
        }),
      });
    },
  );
}

async function assertActiveOwner(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
): Promise<void> {
  const owner = await trx
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
    .where('org_memberships.org_id', '=', orgId)
    .where('org_memberships.account_id', '=', actorId)
    .where('org_memberships.status', '=', 'active')
    .where('role_assignments.role', '=', 'owner')
    .where('role_assignments.scope_type', '=', 'org')
    .where('role_assignments.pending_mfa', '=', false)
    .where('role_assignments.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!owner)
    throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Organization not found');
}

async function assertScope(
  trx: OrgTransaction,
  orgId: string,
  invitation: Invitation,
): Promise<void> {
  if (invitation.scopeType === 'org') return;
  const id = invitation.scopeId;
  if (!id) throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Scope not found');
  let found: { id: string } | undefined;
  switch (invitation.scopeType) {
    case 'season':
      found = await trx
        .selectFrom('seasons')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      break;
    case 'program':
      found = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      break;
    case 'division':
      found = await trx
        .selectFrom('divisions')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      break;
    case 'team_season':
      found = await trx
        .selectFrom('team_seasons')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      break;
  }
  if (!found)
    throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Scope not found');
}

export async function createOrgInvitation(
  dependencies: {
    database: Kysely<DB>;
    email: EmailSender;
    appUrl: string;
  },
  input: {
    orgId: string;
    actorId: string;
    invitation: z.input<typeof orgInvitationSchema>;
    idempotencyKey: string | undefined;
    now: Date;
  },
): Promise<InvitationResponse> {
  const invitation = orgInvitationSchema.parse(input.invitation);
  const email = invitation.email.toLowerCase();
  const key = parseIdempotencyKey(input.idempotencyKey);
  const hash = idempotencyHash(
    'POST',
    `/api/v1/orgs/${input.orgId}/invitations`,
    { ...invitation, email },
  );
  const withOrg = createWithOrg(dependencies.database);
  const result = await withOrg(
    { orgId: input.orgId, actor: { accountId: input.actorId } },
    async (trx) => {
      await assertActiveOwner(trx, input.orgId, input.actorId);
      await trx
        .insertInto('idempotency_keys')
        .values({
          id: newId(),
          org_id: input.orgId,
          actor_id: input.actorId,
          key,
          request_hash: hash,
        })
        .onConflict((conflict) =>
          conflict.columns(['org_id', 'actor_id', 'key']).doNothing(),
        )
        .execute();
      const saved = await trx
        .selectFrom('idempotency_keys')
        .select(['id', 'request_hash', 'response_status', 'response_body'])
        .where('org_id', '=', input.orgId)
        .where('actor_id', '=', input.actorId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!saved.request_hash.equals(hash)) {
        throw new OrgMemberRolesError(
          409,
          'CONFLICT',
          'Idempotency-Key was used for a different invitation',
        );
      }
      if (saved.response_status !== null) {
        return {
          response: orgInvitationResponseSchema.parse(saved.response_body),
          token: null,
        };
      }
      await assertScope(trx, input.orgId, invitation);
      const account = await trx
        .selectFrom('accounts')
        .select('id')
        .where('email', '=', email)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (account) {
        const member = await trx
          .selectFrom('org_memberships')
          .select('status')
          .where('org_id', '=', input.orgId)
          .where('account_id', '=', account.id)
          .executeTakeFirst();
        if (member?.status === 'active') {
          throw new OrgMemberRolesError(
            409,
            'CONFLICT',
            'This account is already a member',
          );
        }
      }
      const token = await issueAuthToken(
        trx,
        {
          purpose: 'org_invitation',
          email,
          orgId: input.orgId,
          subjectKey: 'membership',
          ...(account ? { accountId: account.id } : {}),
          payload: {
            roles: invitation.roles,
            scopeType: invitation.scopeType,
            scopeId: invitation.scopeId,
          },
          createdBy: input.actorId,
        },
        input.now,
      );
      const record = await trx
        .selectFrom('auth_tokens')
        .select(['id', 'expires_at'])
        .where('purpose', '=', 'org_invitation')
        .where('org_id', '=', input.orgId)
        .where('email', '=', email)
        .where('subject_key', '=', 'membership')
        .where('revoked_at', 'is', null)
        .where('consumed_at', 'is', null)
        .executeTakeFirstOrThrow();
      const response = orgInvitationResponseSchema.parse({
        id: record.id,
        email,
        expiresAt: record.expires_at.toISOString(),
      });
      await trx
        .updateTable('idempotency_keys')
        .set({ response_status: 201, response_body: response as Json })
        .where('id', '=', saved.id)
        .execute();
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: input.orgId,
          actor_account_id: input.actorId,
          action: 'membership.invitation_sent',
          entity_type: 'auth_token',
          entity_id: record.id,
          changes: { roles: invitation.roles, scopeType: invitation.scopeType },
        })
        .execute();
      return { response, token };
    },
  );
  if (result.token) {
    try {
      await dependencies.email.send({
        to: email,
        subject: 'Join your Athlentry organization',
        text: `Open ${dependencies.appUrl}/invitations/${input.orgId}/${result.token} to accept your organization invitation. This link expires in 7 days.`,
        kind: 'security',
        idempotencyKey: key,
      });
    } catch (error) {
      await withOrg(
        { orgId: input.orgId, actor: { accountId: input.actorId } },
        async (trx) => {
          await trx
            .updateTable('auth_tokens')
            .set({ revoked_at: input.now })
            .where('id', '=', result.response.id)
            .where('consumed_at', 'is', null)
            .execute();
          await trx
            .deleteFrom('idempotency_keys')
            .where('org_id', '=', input.orgId)
            .where('actor_id', '=', input.actorId)
            .where('key', '=', key)
            .execute();
        },
      );
      throw error;
    }
  }
  return result.response;
}

export async function resendOrgInvitation(
  dependencies: { database: Kysely<DB>; email: EmailSender; appUrl: string },
  input: {
    orgId: string;
    actorId: string;
    invitationId: string;
    idempotencyKey: string | undefined;
    now: Date;
  },
): Promise<InvitationResponse> {
  const invitation = await createWithOrg(dependencies.database)(
    { orgId: input.orgId, actor: { accountId: input.actorId } },
    async (trx) => {
      await assertActiveOwner(trx, input.orgId, input.actorId);
      const item = await trx
        .selectFrom('auth_tokens')
        .select(['email', 'payload'])
        .where('id', '=', input.invitationId)
        .where('org_id', '=', input.orgId)
        .where('purpose', '=', 'org_invitation')
        .where('consumed_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!item)
        throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Invitation not found');
      const payload = item.payload as Record<string, unknown>;
      return orgInvitationSchema.parse({
        email: item.email,
        roles: payload.roles,
        scopeType: payload.scopeType,
        scopeId: payload.scopeId,
      });
    },
  );
  return createOrgInvitation(dependencies, {
    orgId: input.orgId,
    actorId: input.actorId,
    invitation,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
}

export async function revokeOrgInvitation(
  database: Kysely<DB>,
  input: { orgId: string; actorId: string; invitationId: string; now: Date },
): Promise<void> {
  await createWithOrg(database)(
    { orgId: input.orgId, actor: { accountId: input.actorId } },
    async (trx) => {
      await assertActiveOwner(trx, input.orgId, input.actorId);
      const revoked = await trx
        .updateTable('auth_tokens')
        .set({ revoked_at: input.now })
        .where('id', '=', input.invitationId)
        .where('org_id', '=', input.orgId)
        .where('purpose', '=', 'org_invitation')
        .where('consumed_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!revoked)
        throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Invitation not found');
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: input.orgId,
          actor_account_id: input.actorId,
          action: 'membership.invitation_revoked',
          entity_type: 'auth_token',
          entity_id: input.invitationId,
          changes: {},
        })
        .execute();
    },
  );
}

export async function acceptOrgInvitation(
  database: Kysely<DB>,
  input: { orgId: string; accountId: string; token: string; now: Date },
): Promise<z.output<typeof acceptedOrgInvitationResponseSchema>> {
  const withOrg = createWithOrg(database);
  return withOrg(
    { orgId: input.orgId, actor: { accountId: input.accountId } },
    async (trx) => {
      const account = await trx
        .selectFrom('accounts')
        .select(['email', 'email_verified_at', 'status'])
        .where('id', '=', input.accountId)
        .executeTakeFirst();
      if (
        !account ||
        account.status !== 'active' ||
        !account.email_verified_at
      ) {
        throw new OrgMemberRolesError(
          403,
          'FORBIDDEN',
          'Verify your account first',
        );
      }
      const token = await consumeAuthToken(
        trx,
        'org_invitation',
        input.token,
        input.now,
      );
      if (
        !token ||
        token.orgId !== input.orgId ||
        token.email !== account.email
      ) {
        throw new OrgMemberRolesError(404, 'NOT_FOUND', 'Invitation not found');
      }
      const invitation = orgInvitationSchema.parse({
        email: token.email,
        roles: token.payload.roles,
        scopeType: token.payload.scopeType,
        scopeId: token.payload.scopeId,
      });
      await assertScope(trx, input.orgId, invitation);
      const existing = await trx
        .selectFrom('org_memberships')
        .select(['id', 'status'])
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', input.accountId)
        .forUpdate()
        .executeTakeFirst();
      if (existing?.status === 'active') {
        throw new OrgMemberRolesError(409, 'CONFLICT', 'Already a member');
      }
      const memberId = existing?.id ?? newId();
      if (existing) {
        await trx
          .updateTable('org_memberships')
          .set({ status: 'active', joined_at: input.now })
          .where('id', '=', memberId)
          .execute();
      } else {
        await trx
          .insertInto('org_memberships')
          .values({
            id: memberId,
            org_id: input.orgId,
            account_id: input.accountId,
            status: 'active',
            joined_at: input.now,
          })
          .execute();
      }
      const hasMfa = Boolean(
        await trx
          .selectFrom('mfa_factors')
          .select('id')
          .where('account_id', '=', input.accountId)
          .where('confirmed_at', 'is not', null)
          .executeTakeFirst(),
      );
      for (const role of invitation.roles) {
        await trx
          .insertInto('role_assignments')
          .values({
            id: newId(),
            org_id: input.orgId,
            account_id: input.accountId,
            role,
            scope_type: invitation.scopeType,
            scope_id: invitation.scopeId,
            granted_by: null,
            granted_at: input.now,
            pending_mfa: !hasMfa && ['admin', 'finance'].includes(role),
          })
          .execute();
      }
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: input.orgId,
          actor_account_id: input.accountId,
          action: 'membership.invitation_accepted',
          entity_type: 'org_membership',
          entity_id: memberId,
          changes: { roles: invitation.roles, scopeType: invitation.scopeType },
        })
        .execute();
      return acceptedOrgInvitationResponseSchema.parse({
        orgId: input.orgId,
        accountId: input.accountId,
        roles: invitation.roles,
        pendingMfa:
          !hasMfa &&
          invitation.roles.some((role) => ['admin', 'finance'].includes(role)),
      });
    },
  );
}
