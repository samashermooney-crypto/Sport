import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import {
  athleteInvitationResponseSchema,
  athleteLinkResponseSchema,
} from '@shared/schemas/people';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { createAuthEmail } from '../../integrations/email/templates/auth';
import { revokeSessions } from '../auth/sessions';
import { consumeAuthToken, issueAuthToken } from '../auth/tokens';

import { PeopleError } from './repo';

async function guardianAccess(
  trx: OrgTransaction,
  orgId: string,
  guardianId: string,
  personId: string,
) {
  const link = await trx
    .selectFrom('person_account_links')
    .select('id')
    .where('org_id', '=', orgId)
    .where('person_id', '=', personId)
    .where('account_id', '=', guardianId)
    .where('relationship', '=', 'guardian')
    .where('verified_at', 'is not', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!link)
    throw new PeopleError(404, 'NOT_FOUND', 'Athlete profile not found');
}

function personAge(dateOfBirth: Date, timezone: string): number {
  const birth = dateOfBirth.toISOString().slice(0, 10);
  const today = orgToday(timezone);
  return birth <= today ? ageOnDate(birth, today) : 0;
}

async function minorPerson(
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
    throw new PeopleError(404, 'NOT_FOUND', 'Athlete profile not found');
  const org = await trx
    .selectFrom('organizations')
    .select(['name', 'timezone', 'default_locale'])
    .where('id', '=', orgId)
    .executeTakeFirstOrThrow();
  const age = personAge(person.date_of_birth, org.timezone);
  if (age < 13 || age >= 18)
    throw new PeopleError(409, 'CONFLICT', 'Athlete account age must be 13–17');
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
      'Invitation email must match the athlete profile',
    );
  const duplicateEmail = await trx
    .selectFrom('people')
    .select('id')
    .where('org_id', '=', orgId)
    .where('email', '=', email)
    .where('id', '!=', personId)
    .executeTakeFirst();
  if (duplicateEmail)
    throw new PeopleError(
      409,
      'CONFLICT',
      'Another person uses this profile email',
    );
  const current = await trx
    .selectFrom('person_account_links')
    .select('id')
    .where('org_id', '=', orgId)
    .where('person_id', '=', personId)
    .where('relationship', '=', 'self')
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (current)
    throw new PeopleError(409, 'CONFLICT', 'Athlete already has an account');
  return { person, org, personEmail };
}

async function audit(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  personId: string,
  action: string,
  linkId: string,
) {
  await trx
    .insertInto('audit_log')
    .values({
      id: newId(),
      org_id: orgId,
      actor_account_id: actorId,
      action,
      entity_type: 'person',
      entity_id: personId,
      changes: { linkId },
    })
    .execute();
}

export function createAthleteLinksRepository(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);
  return {
    async get(orgId: string, guardianId: string, personId: string) {
      return withOrg(
        { orgId, actor: { accountId: guardianId } },
        async (trx) => {
          await guardianAccess(trx, orgId, guardianId, personId);
          const person = await trx
            .selectFrom('people')
            .select('date_of_birth')
            .where('org_id', '=', orgId)
            .where('id', '=', personId)
            .executeTakeFirstOrThrow();
          const org = await trx
            .selectFrom('organizations')
            .select('timezone')
            .where('id', '=', orgId)
            .executeTakeFirstOrThrow();
          const account = await trx
            .selectFrom('person_account_links as link')
            .innerJoin('accounts as account', 'account.id', 'link.account_id')
            .select(['link.account_id', 'link.verified_at', 'account.email'])
            .where('link.org_id', '=', orgId)
            .where('link.person_id', '=', personId)
            .where('link.relationship', '=', 'self')
            .where('link.revoked_at', 'is', null)
            .executeTakeFirst();
          return athleteLinkResponseSchema.parse({
            accountId: account?.account_id ?? null,
            email: account?.email ?? null,
            verifiedAt: account?.verified_at?.toISOString() ?? null,
            age: personAge(person.date_of_birth, org.timezone),
          });
        },
      );
    },

    async invite(
      orgId: string,
      guardianId: string,
      personId: string,
      email: string,
      sender: EmailSender,
      appUrl: string,
    ) {
      const normalized = email.trim().toLowerCase();
      const issued = await withOrg(
        { orgId, actor: { accountId: guardianId } },
        async (trx) => {
          await guardianAccess(trx, orgId, guardianId, personId);
          const { person, org, personEmail } = await minorPerson(
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
          if (
            account &&
            (account.status !== 'active' ||
              account.date_of_birth.toISOString().slice(0, 10) !==
                person.date_of_birth.toISOString().slice(0, 10))
          )
            throw new PeopleError(
              409,
              'CONFLICT',
              'Athlete account birth date does not match',
            );
          const token = await issueAuthToken(
            trx,
            {
              purpose: 'athlete_account_invitation',
              email: normalized,
              orgId,
              subjectKey: personId,
              payload: { personId, personEmail, guardianId },
              createdBy: guardianId,
              ...(account ? { accountId: account.id } : {}),
            },
            new Date(),
          );
          const saved = await trx
            .selectFrom('auth_tokens')
            .select(['id', 'expires_at'])
            .where('purpose', '=', 'athlete_account_invitation')
            .where('org_id', '=', orgId)
            .where('email', '=', normalized)
            .where('subject_key', '=', personId)
            .where('consumed_at', 'is', null)
            .where('revoked_at', 'is', null)
            .executeTakeFirstOrThrow();
          await audit(
            trx,
            orgId,
            guardianId,
            personId,
            'athlete.invited',
            saved.id,
          );
          return {
            token,
            response: athleteInvitationResponseSchema.parse({
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
            kind: 'athlete-invitation',
            to: normalized,
            url: `${appUrl}/athlete-invitations/${orgId}/${issued.token}`,
            locale: issued.locale,
            branding: { organizationName: issued.orgName },
          }),
          idempotencyKey: issued.response.id,
        });
      } catch (error) {
        await withOrg({ orgId, actor: { accountId: guardianId } }, (trx) =>
          trx
            .updateTable('auth_tokens')
            .set({ revoked_at: new Date() })
            .where('id', '=', issued.response.id)
            .where('org_id', '=', orgId)
            .where('consumed_at', 'is', null)
            .execute()
            .then(() => undefined),
        );
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
          'athlete_account_invitation',
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
        const { personId, personEmail, guardianId } = token.payload;
        if (
          typeof personId !== 'string' ||
          typeof personEmail !== 'string' ||
          typeof guardianId !== 'string'
        )
          throw new PeopleError(404, 'NOT_FOUND', 'Invitation not found');
        await guardianAccess(trx, orgId, guardianId, personId);
        const { person, personEmail: currentEmail } = await minorPerson(
          trx,
          orgId,
          personId,
          account.email,
          personEmail,
        );
        if (
          account.date_of_birth.toISOString().slice(0, 10) !==
          person.date_of_birth.toISOString().slice(0, 10)
        )
          throw new PeopleError(
            403,
            'FORBIDDEN',
            'Athlete birth date does not match',
          );
        if (!currentEmail)
          await trx
            .updateTable('people')
            .set({
              email: account.email,
              version: person.version + 1,
            })
            .where('org_id', '=', orgId)
            .where('id', '=', personId)
            .execute();
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
        await audit(
          trx,
          orgId,
          accountId,
          personId,
          'athlete.invitation_accepted',
          linkId,
        );
        return { personId, linkId };
      });
    },

    async revoke(orgId: string, guardianId: string, personId: string) {
      return withOrg(
        { orgId, actor: { accountId: guardianId } },
        async (trx) => {
          await guardianAccess(trx, orgId, guardianId, personId);
          const self = await trx
            .selectFrom('person_account_links')
            .select(['id', 'account_id'])
            .where('org_id', '=', orgId)
            .where('person_id', '=', personId)
            .where('relationship', '=', 'self')
            .where('revoked_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
          if (!self)
            throw new PeopleError(404, 'NOT_FOUND', 'Athlete link not found');
          const person = await trx
            .selectFrom('people')
            .select('date_of_birth')
            .where('org_id', '=', orgId)
            .where('id', '=', personId)
            .executeTakeFirstOrThrow();
          const org = await trx
            .selectFrom('organizations')
            .select('timezone')
            .where('id', '=', orgId)
            .executeTakeFirstOrThrow();
          const age = personAge(person.date_of_birth, org.timezone);
          if (age >= 18)
            throw new PeopleError(
              403,
              'FORBIDDEN',
              'An adult controls their own profile',
            );
          const now = new Date();
          await trx
            .updateTable('person_account_links')
            .set({ revoked_at: now })
            .where('org_id', '=', orgId)
            .where('id', '=', self.id)
            .execute();
          await revokeSessions(trx, self.account_id, now);
          await audit(
            trx,
            orgId,
            guardianId,
            personId,
            'athlete.link_revoked',
            self.id,
          );
          return athleteLinkResponseSchema.parse({
            accountId: null,
            email: null,
            verifiedAt: null,
            age,
          });
        },
      );
    },
  };
}
