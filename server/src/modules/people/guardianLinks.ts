import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import {
  guardianLinkResponseSchema,
  guardianLinksResponseSchema,
} from '@shared/schemas/people';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';

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
