import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import { personClaimInvitationResponseSchema } from '@shared/schemas/people';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { createAuthEmail } from '../../integrations/email/templates/auth';
import { consumeAuthToken, issueAuthToken } from '../auth/tokens';

import { PeopleError, requireStaff } from './repo';

async function eligiblePerson(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
  email: string,
  snapshot: string | null,
) {
  const person = await trx
    .selectFrom('people')
    .select(['id', 'date_of_birth', 'email', 'status', 'version'])
    .where('org_id', '=', orgId)
    .where('id', '=', personId)
    .forUpdate()
    .executeTakeFirst();
  if (!person || person.status !== 'active')
    throw new PeopleError(404, 'NOT_FOUND', 'Active person not found');
  const org = await trx
    .selectFrom('organizations')
    .select(['name', 'timezone', 'default_locale'])
    .where('id', '=', orgId)
    .executeTakeFirstOrThrow();
  if (
    ageOnDate(
      person.date_of_birth.toISOString().slice(0, 10),
      orgToday(org.timezone),
    ) < 18
  )
    throw new PeopleError(
      409,
      'CONFLICT',
      'Only an adult profile can be claimed this way',
    );
  const personEmail = person.email?.trim().toLowerCase() ?? '';
  if (snapshot !== null && personEmail !== snapshot)
    throw new PeopleError(
      409,
      'CONFLICT',
      'Profile email changed; request a new invitation',
    );
  if (personEmail && personEmail !== email)
    throw new PeopleError(
      409,
      'CONFLICT',
      'Invitation email must match the profile',
    );
  const conflict = await trx
    .selectFrom('people')
    .select('id')
    .where('org_id', '=', orgId)
    .where('email', '=', email)
    .where('id', '!=', personId)
    .executeTakeFirst();
  if (conflict)
    throw new PeopleError(
      409,
      'CONFLICT',
      'Another person uses this profile email',
    );
  const self = await trx
    .selectFrom('person_account_links')
    .select('id')
    .where('org_id', '=', orgId)
    .where('person_id', '=', personId)
    .where('relationship', '=', 'self')
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (self)
    throw new PeopleError(
      409,
      'CONFLICT',
      'This person already has an account link',
    );
  return { person, org, personEmail };
}

export function createSelfClaimsRepository(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);
  return {
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
          const { org, personEmail } = await eligiblePerson(
            trx,
            orgId,
            personId,
            normalized,
            null,
          );
          const account = await trx
            .selectFrom('accounts')
            .select(['id', 'status', 'date_of_birth'])
            .where('email', '=', normalized)
            .executeTakeFirst();
          if (account) {
            if (
              account.status !== 'active' ||
              ageOnDate(
                account.date_of_birth.toISOString().slice(0, 10),
                orgToday(org.timezone),
              ) < 18
            )
              throw new PeopleError(
                409,
                'CONFLICT',
                'An active adult account is required',
              );
          }
          const token = await issueAuthToken(
            trx,
            {
              purpose: 'claim_person',
              email: normalized,
              orgId,
              subjectKey: personId,
              payload: { personId, personEmail },
              createdBy: actorId,
              ...(account ? { accountId: account.id } : {}),
            },
            new Date(),
          );
          const saved = await trx
            .selectFrom('auth_tokens')
            .select(['id', 'expires_at'])
            .where('purpose', '=', 'claim_person')
            .where('org_id', '=', orgId)
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
              action: 'person.claim_invited',
              entity_type: 'person',
              entity_id: personId,
              changes: { invitationId: saved.id },
            })
            .execute();
          return {
            token,
            response: personClaimInvitationResponseSchema.parse({
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
            kind: 'person-claim',
            to: normalized,
            url: `${appUrl}/claim-person/${orgId}/${issued.token}`,
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
          'claim_person',
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
        const snapshot = token.payload.personEmail;
        if (typeof personId !== 'string' || typeof snapshot !== 'string')
          throw new PeopleError(404, 'NOT_FOUND', 'Invitation not found');
        const { person, org, personEmail } = await eligiblePerson(
          trx,
          orgId,
          personId,
          account.email,
          snapshot,
        );
        if (
          ageOnDate(
            account.date_of_birth.toISOString().slice(0, 10),
            orgToday(org.timezone),
          ) < 18
        )
          throw new PeopleError(
            403,
            'FORBIDDEN',
            'An adult account is required',
          );
        if (!personEmail) {
          await trx
            .updateTable('people')
            .set({
              email: account.email,
              version: person.version + 1,
            })
            .where('org_id', '=', orgId)
            .where('id', '=', personId)
            .execute();
        }
        const linkId = newId();
        await trx
          .insertInto('person_account_links')
          .values({
            id: linkId,
            org_id: orgId,
            person_id: personId,
            account_id: accountId,
            relationship: 'self',
            verified_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: accountId,
            action: 'person.claim_accepted',
            entity_type: 'person',
            entity_id: personId,
            changes: { linkId },
          })
          .execute();
        return { personId, linkId };
      });
    },
  };
}
