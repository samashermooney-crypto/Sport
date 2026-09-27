import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import {
  guardianInvitationResponseSchema,
  guardianLinkResponseSchema,
  guardianLinksResponseSchema,
} from '@shared/schemas/people';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { createAuthEmail } from '../../integrations/email/templates/auth';
import { consumeAuthToken, issueAuthToken } from '../auth/tokens';

import { ensureGuardianProfileAndHousehold } from './guardianProfile';
import { PeopleError, requireStaff } from './repo';

async function activePerson(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
) {
  const person = await trx
    .selectFrom('people')
    .select(['id', 'date_of_birth', 'status'])
    .where('org_id', '=', orgId)
    .where('id', '=', personId)
    .forUpdate()
    .executeTakeFirst();
  if (!person || person.status !== 'active')
    throw new PeopleError(404, 'NOT_FOUND', 'Active person not found');
  return person;
}

async function listLinks(trx: OrgTransaction, orgId: string, personId: string) {
  const rows = await trx
    .selectFrom('person_account_links as link')
    .innerJoin('accounts as account', 'account.id', 'link.account_id')
    .select([
      'link.id',
      'link.account_id',
      'link.verified_at',
      'account.email',
      'account.first_name',
      'account.last_name',
    ])
    .where('link.org_id', '=', orgId)
    .where('link.person_id', '=', personId)
    .where('link.relationship', '=', 'guardian')
    .where('link.revoked_at', 'is', null)
    .where('link.verified_at', 'is not', null)
    .orderBy('account.email')
    .execute();
  return guardianLinksResponseSchema.parse({
    items: rows.map((row) =>
      guardianLinkResponseSchema.parse({
        id: row.id,
        accountId: row.account_id,
        email: row.email,
        name: `${row.first_name} ${row.last_name}`,
        verifiedAt: row.verified_at?.toISOString(),
      }),
    ),
  });
}

export function createGuardianLinksRepository(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);
  return {
    async list(
      orgId: string,
      actorId: string,
      personId: string,
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, impersonating);
        await activePerson(trx, orgId, personId);
        return listLinks(trx, orgId, personId);
      });
    },

    async linkExisting(
      orgId: string,
      actorId: string,
      personId: string,
      email: string,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        await activePerson(trx, orgId, personId);
        const account = await trx
          .selectFrom('accounts')
          .select(['id', 'date_of_birth', 'email_verified_at', 'status'])
          .where('email', '=', email)
          .executeTakeFirst();
        if (
          !account ||
          !account.email_verified_at ||
          account.status !== 'active'
        )
          throw new PeopleError(404, 'NOT_FOUND', 'Verified account not found');
        const org = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', orgId)
          .executeTakeFirstOrThrow();
        const birth = account.date_of_birth.toISOString().slice(0, 10);
        if (ageOnDate(birth, orgToday(org.timezone)) < 18)
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'Guardian account must be an adult',
          );
        const existing = await trx
          .selectFrom('person_account_links')
          .select('id')
          .where('org_id', '=', orgId)
          .where('person_id', '=', personId)
          .where('account_id', '=', account.id)
          .where('relationship', '=', 'guardian')
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (existing)
          throw new PeopleError(409, 'CONFLICT', 'Guardian is already linked');
        await ensureGuardianProfileAndHousehold(
          trx,
          orgId,
          account.id,
          personId,
          actorId,
        );
        const id = newId();
        await trx
          .insertInto('person_account_links')
          .values({
            id,
            org_id: orgId,
            person_id: personId,
            account_id: account.id,
            relationship: 'guardian',
            verified_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: actorId,
            action: 'person.guardian_linked',
            entity_type: 'person',
            entity_id: personId,
            changes: { linkId: id, accountId: account.id },
          })
          .execute();
        return listLinks(trx, orgId, personId);
      });
    },

    async invite(
      orgId: string,
      actorId: string,
      personId: string,
      email: string,
      sender: EmailSender,
      appUrl: string,
    ) {
      const normalized = email.trim().toLowerCase();
      const issued = await withOrg(
        { orgId, actor: { accountId: actorId } },
        async (trx) => {
          await requireStaff(trx, orgId, actorId, false);
          await activePerson(trx, orgId, personId);
          const account = await trx
            .selectFrom('accounts')
            .select(['id', 'status', 'date_of_birth'])
            .where('email', '=', normalized)
            .executeTakeFirst();
          if (account && account.status !== 'active')
            throw new PeopleError(409, 'CONFLICT', 'Account is not active');
          const org = await trx
            .selectFrom('organizations')
            .select(['name', 'timezone', 'default_locale'])
            .where('id', '=', orgId)
            .executeTakeFirstOrThrow();
          if (account) {
            const birth = account.date_of_birth.toISOString().slice(0, 10);
            if (ageOnDate(birth, orgToday(org.timezone)) < 18)
              throw new PeopleError(
                400,
                'VALIDATION_ERROR',
                'Guardian account must be an adult',
              );
          }
          const existing = account
            ? await trx
                .selectFrom('person_account_links')
                .select('id')
                .where('org_id', '=', orgId)
                .where('person_id', '=', personId)
                .where('account_id', '=', account.id)
                .where('relationship', '=', 'guardian')
                .where('revoked_at', 'is', null)
                .executeTakeFirst()
            : null;
          if (existing)
            throw new PeopleError(
              409,
              'CONFLICT',
              'Guardian is already linked',
            );
          const now = new Date();
          const token = await issueAuthToken(
            trx,
            {
              purpose: 'guardian_invitation',
              email: normalized,
              orgId,
              subjectKey: personId,
              payload: { personId },
              createdBy: actorId,
              ...(account ? { accountId: account.id } : {}),
            },
            now,
          );
          const saved = await trx
            .selectFrom('auth_tokens')
            .select(['id', 'expires_at'])
            .where('org_id', '=', orgId)
            .where('purpose', '=', 'guardian_invitation')
            .where('email', '=', normalized)
            .where('subject_key', '=', personId)
            .where('consumed_at', 'is', null)
            .where('revoked_at', 'is', null)
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('audit_log')
            .values({
              id: newId(),
              org_id: orgId,
              actor_account_id: actorId,
              action: 'person.guardian_invited',
              entity_type: 'person',
              entity_id: personId,
              changes: { invitationId: saved.id },
            })
            .execute();
          return {
            token,
            response: guardianInvitationResponseSchema.parse({
              id: saved.id,
              email: normalized,
              expiresAt: saved.expires_at.toISOString(),
            }),
            orgName: org.name,
            locale:
              org.default_locale === 'es' ? ('es' as const) : ('en' as const),
          };
        },
      );
      try {
        await sender.send({
          ...createAuthEmail({
            kind: 'guardian-invitation',
            to: normalized,
            url: `${appUrl}/guardian-invitations/${orgId}/${issued.token}`,
            locale: issued.locale,
            branding: { organizationName: issued.orgName },
          }),
          idempotencyKey: issued.response.id,
        });
      } catch (error) {
        await withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
          await trx
            .updateTable('auth_tokens')
            .set({ revoked_at: new Date() })
            .where('id', '=', issued.response.id)
            .where('org_id', '=', orgId)
            .where('consumed_at', 'is', null)
            .execute();
        });
        throw error;
      }
      return issued.response;
    },

    async accept(orgId: string, accountId: string, rawToken: string) {
      return withOrg({ orgId, actor: { accountId } }, async (trx) => {
        const account = await trx
          .selectFrom('accounts')
          .select(['email', 'email_verified_at', 'date_of_birth', 'status'])
          .where('id', '=', accountId)
          .executeTakeFirst();
        if (
          !account ||
          account.status !== 'active' ||
          !account.email_verified_at
        )
          throw new PeopleError(403, 'FORBIDDEN', 'Verify your account first');
        const token = await consumeAuthToken(
          trx,
          'guardian_invitation',
          rawToken,
          new Date(),
        );
        if (
          !token ||
          token.orgId !== orgId ||
          token.email !== account.email ||
          (token.accountId && token.accountId !== accountId)
        )
          throw new PeopleError(404, 'NOT_FOUND', 'Invitation not found');
        const personId = token.payload.personId;
        if (typeof personId !== 'string')
          throw new PeopleError(404, 'NOT_FOUND', 'Invitation not found');
        await activePerson(trx, orgId, personId);
        const org = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', orgId)
          .executeTakeFirstOrThrow();
        const birth = account.date_of_birth.toISOString().slice(0, 10);
        if (ageOnDate(birth, orgToday(org.timezone)) < 18)
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'Guardian account must be an adult',
          );
        const existing = await trx
          .selectFrom('person_account_links')
          .select('id')
          .where('org_id', '=', orgId)
          .where('person_id', '=', personId)
          .where('account_id', '=', accountId)
          .where('relationship', '=', 'guardian')
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (existing)
          throw new PeopleError(409, 'CONFLICT', 'Guardian is already linked');
        await ensureGuardianProfileAndHousehold(
          trx,
          orgId,
          accountId,
          personId,
          accountId,
        );
        const linkId = newId();
        await trx
          .insertInto('person_account_links')
          .values({
            id: linkId,
            org_id: orgId,
            person_id: personId,
            account_id: accountId,
            relationship: 'guardian',
            verified_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: accountId,
            action: 'person.guardian_invitation_accepted',
            entity_type: 'person',
            entity_id: personId,
            changes: { linkId },
          })
          .execute();
        return { personId, linkId };
      });
    },

    async revoke(
      orgId: string,
      actorId: string,
      personId: string,
      linkId: string,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const person = await activePerson(trx, orgId, personId);
        const link = await trx
          .selectFrom('person_account_links')
          .select(['id', 'account_id'])
          .where('org_id', '=', orgId)
          .where('person_id', '=', personId)
          .where('id', '=', linkId)
          .where('relationship', '=', 'guardian')
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (!link)
          throw new PeopleError(404, 'NOT_FOUND', 'Guardian link not found');
        const org = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', orgId)
          .executeTakeFirstOrThrow();
        const birth = person.date_of_birth.toISOString().slice(0, 10);
        if (ageOnDate(birth, orgToday(org.timezone)) < 18) {
          const selfLink = await trx
            .selectFrom('person_account_links')
            .select('id')
            .where('org_id', '=', orgId)
            .where('person_id', '=', personId)
            .where('relationship', '=', 'self')
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
          if (selfLink) {
            const guardians = await trx
              .selectFrom('person_account_links')
              .select('id')
              .where('org_id', '=', orgId)
              .where('person_id', '=', personId)
              .where('relationship', '=', 'guardian')
              .where('verified_at', 'is not', null)
              .where('revoked_at', 'is', null)
              .execute();
            if (guardians.length <= 1)
              throw new PeopleError(
                409,
                'CONFLICT',
                'An athlete account requires an active guardian',
              );
          }
        }
        await trx
          .updateTable('person_account_links')
          .set({ revoked_at: new Date() })
          .where('id', '=', linkId)
          .where('org_id', '=', orgId)
          .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: actorId,
            action: 'person.guardian_revoked',
            entity_type: 'person',
            entity_id: personId,
            changes: { linkId, accountId: link.account_id },
          })
          .execute();
        return listLinks(trx, orgId, personId);
      });
    },
  };
}
