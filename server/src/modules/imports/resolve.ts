import { newId } from '@shared/ids';
import { sql } from 'kysely';

import type { OrgTransaction } from '../../db/withOrg';

export interface PersonRef {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

export async function findPerson(
  trx: OrgTransaction,
  orgId: string,
  key: {
    email?: string | null;
    first?: string;
    last?: string;
    dob?: string | null;
  },
): Promise<{ match: PersonRef | null; ambiguous: boolean }> {
  if (key.email) {
    const row = await trx
      .selectFrom('people')
      .select(['id', 'first_name', 'last_name', 'email'])
      .where('org_id', '=', orgId)
      .where('email', '=', key.email)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return { match: row ?? null, ambiguous: false };
  }
  if (key.first && key.last) {
    let statement = trx
      .selectFrom('people')
      .select(['id', 'first_name', 'last_name', 'email'])
      .where('org_id', '=', orgId)
      .where('status', '=', 'active')
      .where(sql<boolean>`lower(first_name) = lower(${key.first})`)
      .where(sql<boolean>`lower(last_name) = lower(${key.last})`);
    if (key.dob)
      statement = statement.where(
        sql<boolean>`people.date_of_birth = ${key.dob}::date`,
      );
    const rows = await statement.limit(3).execute();
    return { match: rows[0] ?? null, ambiguous: rows.length > 1 };
  }
  return { match: null, ambiguous: false };
}

export async function findProgram(
  trx: OrgTransaction,
  orgId: string,
  nameOrSlug: string,
): Promise<{
  id: string;
  name: string;
  sport_profile_id: string;
  season_id: string;
} | null> {
  const needle = nameOrSlug.trim();
  return (
    (await trx
      .selectFrom('programs')
      .select(['id', 'name', 'sport_profile_id', 'season_id'])
      .where('org_id', '=', orgId)
      .where((eb) =>
        eb.or([
          eb('slug', '=', needle.toLowerCase()),
          sql<boolean>`lower(name) = lower(${needle})`,
        ]),
      )
      .executeTakeFirst()) ?? null
  );
}

export async function findDivision(
  trx: OrgTransaction,
  orgId: string,
  programId: string,
  nameOrLabel: string | null,
): Promise<{ id: string; name: string } | null> {
  if (!nameOrLabel) {
    const first = await trx
      .selectFrom('divisions')
      .select(['id', 'name'])
      .where('org_id', '=', orgId)
      .where('program_id', '=', programId)
      .orderBy('sort_order')
      .orderBy('name')
      .limit(1)
      .executeTakeFirst();
    return first ?? null;
  }
  const needle = nameOrLabel.trim();
  const match = await trx
    .selectFrom('divisions')
    .select(['id', 'name'])
    .where('org_id', '=', orgId)
    .where('program_id', '=', programId)
    .where((eb) =>
      eb.or([
        sql<boolean>`lower(name) = lower(${needle})`,
        sql<boolean>`lower(coalesce(age_label, '')) = lower(${needle})`,
        sql<boolean>`lower(coalesce(code, '')) = lower(${needle})`,
      ]),
    )
    .executeTakeFirst();
  return match ?? null;
}

export async function findOffering(
  trx: OrgTransaction,
  orgId: string,
  programId: string,
  name: string | null,
): Promise<{ id: string; name: string; division_id: string | null } | null> {
  let statement = trx
    .selectFrom('registration_offerings')
    .select(['id', 'name', 'division_id'])
    .where('org_id', '=', orgId)
    .where('program_id', '=', programId)
    .orderBy('active', 'desc');
  if (name)
    statement = statement.where(
      sql<boolean>`lower(name) = lower(${name.trim()})`,
    );
  return (
    (await statement
      .orderBy('sort_order')
      .orderBy('name')
      .limit(1)
      .executeTakeFirst()) ?? null
  );
}

export async function findTeamSeason(
  trx: OrgTransaction,
  orgId: string,
  teamName: string,
  programId: string | null,
): Promise<{
  teamSeasonId: string;
  teamId: string;
  programId: string;
  divisionId: string;
} | null> {
  const needle = teamName.trim();
  let statement = trx
    .selectFrom('team_seasons')
    .innerJoin('teams', (join) =>
      join
        .onRef('teams.org_id', '=', 'team_seasons.org_id')
        .onRef('teams.id', '=', 'team_seasons.team_id'),
    )
    .select([
      'team_seasons.id as teamSeasonId',
      'team_seasons.team_id as teamId',
      'team_seasons.program_id as programId',
      'team_seasons.division_id as divisionId',
    ])
    .where('team_seasons.org_id', '=', orgId)
    .where((eb) =>
      eb.or([
        sql<boolean>`lower(teams.name) = lower(${needle})`,
        sql<boolean>`lower(coalesce(team_seasons.display_name, '')) = lower(${needle})`,
      ]),
    );
  if (programId)
    statement = statement.where('team_seasons.program_id', '=', programId);
  const rows = await statement.limit(2).execute();
  return rows.length === 1 ? (rows[0] ?? null) : (rows[0] ?? null);
}

export async function findFacility(
  trx: OrgTransaction,
  orgId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  return (
    (await trx
      .selectFrom('facilities')
      .select(['id', 'name'])
      .where('org_id', '=', orgId)
      .where('archived_at', 'is', null)
      .where(sql<boolean>`lower(name) = lower(${name.trim()})`)
      .executeTakeFirst()) ?? null
  );
}

export async function findSpace(
  trx: OrgTransaction,
  orgId: string,
  facilityId: string | null,
  name: string,
): Promise<{ id: string; facility_id: string } | null> {
  let statement = trx
    .selectFrom('spaces')
    .select(['id', 'facility_id'])
    .where('org_id', '=', orgId)
    .where('archived_at', 'is', null)
    .where(sql<boolean>`lower(name) = lower(${name.trim()})`);
  if (facilityId) statement = statement.where('facility_id', '=', facilityId);
  return (await statement.limit(2).execute())[0] ?? null;
}

export async function primaryHousehold(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom('household_members')
    .select('household_id')
    .where('org_id', '=', orgId)
    .where('person_id', '=', personId)
    .where('removed_at', 'is', null)
    .orderBy('is_primary_contact', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.household_id ?? null;
}

export async function ensureHousehold(
  trx: OrgTransaction,
  orgId: string,
  person: PersonRef,
): Promise<string> {
  const existing = await primaryHousehold(trx, orgId, person.id);
  if (existing) return existing;
  const householdId = newId();
  await trx
    .insertInto('households')
    .values({
      id: householdId,
      org_id: orgId,
      name: `${person.last_name} household`,
    })
    .execute();
  await trx
    .insertInto('household_members')
    .values({
      id: newId(),
      org_id: orgId,
      household_id: householdId,
      person_id: person.id,
      role: 'athlete',
    })
    .execute();
  return householdId;
}

export async function accountForPerson(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom('person_account_links')
    .select('account_id')
    .where('org_id', '=', orgId)
    .where('person_id', '=', personId)
    .where('revoked_at', 'is', null)
    .orderBy(sql`case when relationship = 'self' then 0 else 1 end`)
    .limit(1)
    .executeTakeFirst();
  return row?.account_id ?? null;
}
