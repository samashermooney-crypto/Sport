import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';

import type { OrgTransaction } from '../../db/withOrg';
import { PeopleError } from './repo';

export interface GuardianProfileCreatedRef {
  type: 'person' | 'household' | 'household_member' | 'person_account_link';
  id: string;
}

/**
 * Ensures a guardian account has its own org-scoped person identity and is a
 * descriptive member of the child's household before guardian access is added.
 */
export async function ensureGuardianProfileAndHousehold(
  trx: OrgTransaction,
  orgId: string,
  accountId: string,
  childPersonId: string,
  actorId: string,
): Promise<{
  guardianPersonId: string;
  householdId: string;
  createdRefs: GuardianProfileCreatedRef[];
}> {
  const createdRefs: GuardianProfileCreatedRef[] = [];
  const account = await trx
    .selectFrom('accounts')
    .select([
      'id',
      'email',
      'email_verified_at',
      'first_name',
      'last_name',
      'date_of_birth',
      'status',
    ])
    .where('id', '=', accountId)
    .forUpdate()
    .executeTakeFirst();
  if (!account || account.status !== 'active' || !account.email_verified_at)
    throw new PeopleError(404, 'NOT_FOUND', 'Verified account not found');

  const org = await trx
    .selectFrom('organizations')
    .select(['timezone'])
    .where('id', '=', orgId)
    .executeTakeFirstOrThrow();
  const birthDate = account.date_of_birth.toISOString().slice(0, 10);
  if (ageOnDate(birthDate, orgToday(org.timezone)) < 18)
    throw new PeopleError(400, 'VALIDATION_ERROR', 'Guardian account must be an adult');

  const child = await trx
    .selectFrom('people')
    .select(['id', 'first_name', 'last_name', 'status'])
    .where('org_id', '=', orgId)
    .where('id', '=', childPersonId)
    .forUpdate()
    .executeTakeFirst();
  if (!child || child.status !== 'active')
    throw new PeopleError(404, 'NOT_FOUND', 'Active person not found');

  let guardianPersonId = await trx
    .selectFrom('person_account_links')
    .select('person_id')
    .where('org_id', '=', orgId)
    .where('account_id', '=', accountId)
    .where('relationship', '=', 'self')
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
    .then((row) => row?.person_id);

  if (!guardianPersonId) {
    const existingProfile = await trx
      .selectFrom('people as person')
      .select(['person.id'])
      .where('person.org_id', '=', orgId)
      .where('person.status', '=', 'active')
      .where('person.email', '=', account.email)
      .where('person.date_of_birth', '=', account.date_of_birth)
      .where('person.first_name', '=', account.first_name)
      .where('person.last_name', '=', account.last_name)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('person_account_links as link')
              .select('link.id')
              .whereRef('link.org_id', '=', 'person.org_id')
              .whereRef('link.person_id', '=', 'person.id')
              .where('link.relationship', '=', 'self')
              .where('link.revoked_at', 'is', null),
          ),
        ),
      )
      .executeTakeFirst();
    guardianPersonId = existingProfile?.id ?? newId();
    if (!existingProfile) {
      await trx
        .insertInto('people')
        .values({
          id: guardianPersonId,
          org_id: orgId,
          first_name: account.first_name,
          last_name: account.last_name,
          date_of_birth: birthDate,
          email: account.email,
        })
        .execute();
      createdRefs.push({ type: 'person', id: guardianPersonId });
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: orgId,
          actor_account_id: actorId,
          action: 'person.guardian_profile_created',
          entity_type: 'person',
          entity_id: guardianPersonId,
          changes: { source: 'guardian_link' },
        })
        .execute();
    }
    const selfLinkId = newId();
    await trx
      .insertInto('person_account_links')
      .values({
        id: selfLinkId,
        org_id: orgId,
        person_id: guardianPersonId,
        account_id: accountId,
        relationship: 'self',
        verified_at: account.email_verified_at,
      })
      .execute();
    createdRefs.push({ type: 'person_account_link', id: selfLinkId });
  }

  const household = await trx
    .selectFrom('household_members as member')
    .innerJoin('households as household', (join) =>
      join
        .onRef('household.org_id', '=', 'member.org_id')
        .onRef('household.id', '=', 'member.household_id'),
    )
    .select(['household.id', 'household.created_at'])
    .where('member.org_id', '=', orgId)
    .where('member.person_id', '=', childPersonId)
    .where('member.removed_at', 'is', null)
    .where('household.status', '=', 'active')
    .orderBy('household.created_at')
    .orderBy('household.id')
    .executeTakeFirst();
  const householdId = household?.id ?? newId();
  if (!household) {
    await trx
      .insertInto('households')
      .values({
        id: householdId,
        org_id: orgId,
        name: `${child.first_name} ${child.last_name} Household`,
      })
      .execute();
    createdRefs.push({ type: 'household', id: householdId });
    const childMembershipId = newId();
    await trx
      .insertInto('household_members')
      .values({
        id: childMembershipId,
        org_id: orgId,
        household_id: householdId,
        person_id: childPersonId,
        role: 'athlete',
      })
      .execute();
    createdRefs.push({ type: 'household_member', id: childMembershipId });
  }

  const guardianMembership = await trx
    .selectFrom('household_members')
    .select(['id', 'role'])
    .where('org_id', '=', orgId)
    .where('household_id', '=', householdId)
    .where('person_id', '=', guardianPersonId)
    .where('removed_at', 'is', null)
    .executeTakeFirst();
  if (guardianMembership) {
    if (guardianMembership.role !== 'guardian')
      await trx
        .updateTable('household_members')
        .set({ role: 'guardian' })
        .where('org_id', '=', orgId)
        .where('id', '=', guardianMembership.id)
        .execute();
  } else {
    const guardianMembershipId = newId();
    await trx
      .insertInto('household_members')
      .values({
        id: guardianMembershipId,
        org_id: orgId,
        household_id: householdId,
        person_id: guardianPersonId,
        role: 'guardian',
      })
      .execute();
    createdRefs.push({ type: 'household_member', id: guardianMembershipId });
  }

  return { guardianPersonId, householdId, createdRefs };
}
