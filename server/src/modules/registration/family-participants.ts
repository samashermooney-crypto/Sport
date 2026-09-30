import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import { ensureGuardianProfileAndHousehold } from '../people/guardianProfile';
import { PeopleError } from '../people/repo';

export const familyParticipantInputSchema = z.strictObject({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  dateOfBirth: z.iso.date(),
  gender: z
    .enum(['female', 'male', 'nonbinary', 'unspecified'])
    .default('unspecified'),
});

export const familyParticipantSchema = z.strictObject({
  personId: z.uuid(),
  householdId: z.uuid(),
  name: z.string(),
  created: z.boolean(),
});

const maxChildrenPerAccount = 12;

/**
 * Lets a signed-in adult add their own child to an organization so the child
 * can be registered (new-family journey). The adult gets their own person
 * and a household per C3, the child joins that household, and the adult is
 * the verified guardian. Adding the same child again returns the existing
 * person instead of creating a duplicate.
 */
export async function addFamilyParticipant(
  database: Kysely<DB>,
  orgId: string,
  accountId: string,
  input: z.input<typeof familyParticipantInputSchema>,
): Promise<z.output<typeof familyParticipantSchema>> {
  const value = familyParticipantInputSchema.parse(input);
  return createWithOrg(database)(
    { orgId, actor: { accountId } },
    async (trx) => {
      const org = await trx
        .selectFrom('organizations')
        .select(['timezone', 'status'])
        .where('id', '=', orgId)
        .executeTakeFirst();
      if (!org || !['onboarding', 'active'].includes(org.status))
        throw new PeopleError(404, 'NOT_FOUND', 'Organization not found');
      const today = orgToday(org.timezone);
      if (value.dateOfBirth > today)
        throw new PeopleError(
          400,
          'VALIDATION_ERROR',
          'Date of birth cannot be in the future',
        );
      if (ageOnDate(value.dateOfBirth, today) >= 18)
        throw new PeopleError(
          400,
          'VALIDATION_ERROR',
          'Adults register with their own account',
        );

      const linked = await sql<{
        person_id: string;
        first_name: string;
        last_name: string;
        date_of_birth: string;
      }>`
        SELECT person.id AS person_id, person.first_name, person.last_name,
          person.date_of_birth::text AS date_of_birth
        FROM person_account_links link
        JOIN people person
          ON person.org_id = link.org_id AND person.id = link.person_id
        WHERE link.org_id = ${orgId}::uuid
          AND link.account_id = ${accountId}::uuid
          AND link.relationship = 'guardian'
          AND link.revoked_at IS NULL
          AND person.status = 'active'
        FOR UPDATE OF link
      `.execute(trx);
      const existing = linked.rows.find(
        (row) =>
          row.first_name.toLowerCase() === value.firstName.toLowerCase() &&
          row.last_name.toLowerCase() === value.lastName.toLowerCase() &&
          row.date_of_birth === value.dateOfBirth,
      );
      if (existing) {
        const membership = await trx
          .selectFrom('household_members')
          .select('household_id')
          .where('org_id', '=', orgId)
          .where('person_id', '=', existing.person_id)
          .where('removed_at', 'is', null)
          .orderBy('created_at')
          .executeTakeFirstOrThrow();
        return {
          personId: existing.person_id,
          householdId: membership.household_id,
          name: `${existing.first_name} ${existing.last_name}`,
          created: false,
        };
      }
      if (linked.rows.length >= maxChildrenPerAccount)
        throw new PeopleError(
          409,
          'CONFLICT',
          'Contact the organization to add more family members',
        );

      // Reuse the household the adult already manages, if any.
      const household = await trx
        .selectFrom('person_account_links as link')
        .innerJoin('household_members as member', (join) =>
          join
            .onRef('member.org_id', '=', 'link.org_id')
            .onRef('member.person_id', '=', 'link.person_id'),
        )
        .innerJoin('households as household', (join) =>
          join
            .onRef('household.org_id', '=', 'member.org_id')
            .onRef('household.id', '=', 'member.household_id'),
        )
        .select('household.id')
        .where('link.org_id', '=', orgId)
        .where('link.account_id', '=', accountId)
        .where('link.relationship', '=', 'self')
        .where('link.revoked_at', 'is', null)
        .where('member.role', '=', 'guardian')
        .where('member.removed_at', 'is', null)
        .where('household.status', '=', 'active')
        .orderBy('household.created_at')
        .executeTakeFirst();

      const personId = newId();
      await trx
        .insertInto('people')
        .values({
          id: personId,
          org_id: orgId,
          first_name: value.firstName,
          last_name: value.lastName,
          date_of_birth: value.dateOfBirth,
          gender: value.gender,
        })
        .execute();
      if (household)
        await trx
          .insertInto('household_members')
          .values({
            id: newId(),
            org_id: orgId,
            household_id: household.id,
            person_id: personId,
            role: 'athlete',
          })
          .execute();
      const profile = await ensureGuardianProfileAndHousehold(
        trx,
        orgId,
        accountId,
        personId,
        accountId,
      );
      if (!household) {
        const account = await trx
          .selectFrom('accounts')
          .select('last_name')
          .where('id', '=', accountId)
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('households')
          .set({ name: `${account.last_name} family` })
          .where('org_id', '=', orgId)
          .where('id', '=', profile.householdId)
          .execute();
      }
      if (!household)
        await trx
          .updateTable('household_members')
          .set({
            is_primary_contact: true,
            financially_responsible: true,
            can_pick_up: true,
          })
          .where('org_id', '=', orgId)
          .where('household_id', '=', profile.householdId)
          .where('person_id', '=', profile.guardianPersonId)
          .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
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
          action: 'person.family_added',
          entity_type: 'person',
          entity_id: personId,
          changes: {
            householdId: profile.householdId,
            guardianPersonId: profile.guardianPersonId,
            source: 'family_registration',
          },
        })
        .execute();
      return {
        personId,
        householdId: profile.householdId,
        name: `${value.firstName} ${value.lastName}`,
        created: true,
      };
    },
  );
}
