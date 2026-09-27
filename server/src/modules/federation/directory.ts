
import { federationSharingSchema } from '@shared/schemas/federation';
import type {
  FederationRelationship,
  RosterSnapshotPlayer,
} from '@shared/schemas/federation';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import type { OrgContext } from '../../db/withOrg';
import { createWithOrg } from '../../db/withOrg';

import { federationNotFound } from './errors';
import {
  assertActiveRelationship,
  requireSharingKey,
  withFederationAccess,
} from './privileged';

export interface MemberSummary {
  relationshipId: string;
  memberOrgId: string;
  memberOrgName: string;
  status: string;
  dataSharing: Record<string, boolean>;
  entryCounts: Record<string, number>;
  openDiscipline: number;
  outstandingFeeCents: number;
}

/** League-side member club directory built from league-owned rows only. */
export async function listMembers(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<MemberSummary[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const relationships = await trx
      .selectFrom('org_relationships')
      .selectAll()
      .where('parent_org_id', '=', context.orgId)
      .where('status', 'in', ['active', 'suspended'])
      .orderBy('created_at')
      .execute();
    if (!relationships.length) return [];
    const memberIds = relationships.map((row) => row.child_org_id);
    const orgNames = await trx
      .selectFrom('organizations')
      .select(['id', 'name'])
      .where('id', 'in', memberIds)
      .execute();
    const nameById = new Map(orgNames.map((row) => [row.id, row.name]));
    const entries = await trx
      .selectFrom('team_entries')
      .select(['entrant_org_id', 'status'])
      .where('entrant_org_id', 'in', memberIds)
      .execute();
    const discipline = await trx
      .selectFrom('federation_discipline_records')
      .select(['member_org_id'])
      .where('member_org_id', 'in', memberIds)
      .where('status', '=', 'active')
      .execute();
    const fees = await trx
      .selectFrom('federation_fee_assessments as fee')
      .innerJoin('invoices', (join) =>
        join
          .onRef('invoices.org_id', '=', 'fee.org_id')
          .onRef('invoices.id', '=', 'fee.invoice_id'),
      )
      .select(['fee.member_org_id', 'invoices.balance_cents'])
      .where('fee.member_org_id', 'in', memberIds)
      .where('fee.status', '=', 'invoiced')
      .execute();
    return relationships.map((relationship) => {
      const entryCounts: Record<string, number> = {};
      for (const entry of entries) {
        if (entry.entrant_org_id !== relationship.child_org_id) continue;
        entryCounts[entry.status] = (entryCounts[entry.status] ?? 0) + 1;
      }
      return {
        relationshipId: relationship.id,
        memberOrgId: relationship.child_org_id,
        memberOrgName: nameById.get(relationship.child_org_id) ?? 'Member club',
        status: relationship.status,
        dataSharing: (relationship.data_sharing ?? {}) as Record<
          string,
          boolean
        >,
        entryCounts,
        openDiscipline: discipline.filter(
          (row) => row.member_org_id === relationship.child_org_id,
        ).length,
        outstandingFeeCents: fees
          .filter((row) => row.member_org_id === relationship.child_org_id)
          .reduce((sum, row) => sum + (row.balance_cents ?? 0), 0),
      };
    });
  });
}

/**
 * Privileged read: roster of a member-club team_season. Requires
 * `rosters` sharing. Returns ONLY the allow-listed fields — person ids are
 * opaque references; emails, phones, DOB, addresses and photos never cross.
 */
export async function readMemberRoster(
  context: OrgContext,
  memberOrgId: string,
  teamSeasonId: string,
): Promise<{ teamSeasonId: string; players: RosterSnapshotPlayer[] }> {
  return withFederationAccess(
    {
      requesting: context,
      sourceOrgId: memberOrgId,
      audit: {
        action: 'federation.cross_org.read',
        entityType: 'team_season',
        entityId: teamSeasonId,
        requestingChanges: {
          dataset: { tier: 'internal', after: 'rosters' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'rosters' },
        },
      },
    },
    async (trx) => {
      const relationship = await assertActiveRelationship(
        trx,
        context.orgId,
        memberOrgId,
      );
      requireSharingKey(relationship, 'rosters');
      const teamSeason = await trx
        .selectFrom('team_seasons')
        .select(['id'])
        .where('org_id', '=', memberOrgId)
        .where('id', '=', teamSeasonId)
        .executeTakeFirst();
      if (!teamSeason) throw federationNotFound('Team season not found');
      const rows = await trx
        .selectFrom('roster_entries')
        .innerJoin('people', (join) =>
          join
            .onRef('people.org_id', '=', 'roster_entries.org_id')
            .onRef('people.id', '=', 'roster_entries.person_id'),
        )
        .leftJoin('athlete_cards', (join) =>
          join
            .onRef('athlete_cards.org_id', '=', 'people.org_id')
            .onRef('athlete_cards.person_id', '=', 'people.id')
            .on('athlete_cards.status', '=', 'active'),
        )
        .select([
          'people.id as person_ref',
          'people.first_name',
          'people.last_name',
          'people.date_of_birth',
          'people.media_consent',
          'roster_entries.jersey_number',
          'roster_entries.positions',
          'athlete_cards.card_number',
        ])
        .where('roster_entries.org_id', '=', memberOrgId)
        .where('roster_entries.team_season_id', '=', teamSeasonId)
        .where('roster_entries.status', '=', 'active')
        .orderBy('people.last_name')
        .orderBy('people.first_name')
        .execute();
      return {
        teamSeasonId,
        players: rows.map((row) => ({
          personRef: row.person_ref,
          firstName: row.first_name,
          lastName: row.last_name,
          birthYear: new Date(row.date_of_birth).getUTCFullYear(),
          ageLabel: null,
          jerseyNumber: row.jersey_number,
          positions: row.positions,
          cardNumber: row.card_number,
          mediaConsent: row.media_consent as 'granted' | 'denied' | 'unknown',
        })),
      };
    },
  );
}

/**
 * Privileged read: compliance status rollup for member-club team staff.
 * Requires `complianceStatus` sharing. Returns derived statuses only —
 * never documents, notes, or medical data.
 */
export async function readMemberCompliance(
  context: OrgContext,
  memberOrgId: string,
): Promise<{
  memberOrgId: string;
  staff: {
    personRef: string;
    firstName: string;
    lastName: string;
    role: string;
    teamName: string | null;
    credentialStatus: 'cleared' | 'pending' | 'expired' | 'missing';
    expiresOn: string | null;
  }[];
}> {
  return withFederationAccess(
    {
      requesting: context,
      sourceOrgId: memberOrgId,
      audit: {
        action: 'federation.cross_org.read',
        entityType: 'org_relationship',
        entityId: memberOrgId,
        requestingChanges: {
          dataset: { tier: 'internal', after: 'complianceStatus' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'complianceStatus' },
        },
      },
    },
    async (trx) => {
      const relationship = await assertActiveRelationship(
        trx,
        context.orgId,
        memberOrgId,
      );
      requireSharingKey(relationship, 'complianceStatus');
      const staff = await trx
        .selectFrom('team_staff')
        .innerJoin('people', (join) =>
          join
            .onRef('people.org_id', '=', 'team_staff.org_id')
            .onRef('people.id', '=', 'team_staff.person_id'),
        )
        .leftJoin('team_seasons', (join) =>
          join
            .onRef('team_seasons.org_id', '=', 'team_staff.org_id')
            .onRef('team_seasons.id', '=', 'team_staff.team_season_id'),
        )
        .select([
          'people.id as person_ref',
          'people.first_name',
          'people.last_name',
          'team_staff.role',
          'team_seasons.display_name',
        ])
        .where('team_staff.org_id', '=', memberOrgId)
        .orderBy('people.last_name')
        .limit(500)
        .execute();
      const personIds = staff.map((row) => row.person_ref);
      const credentials = personIds.length
        ? await trx
            .selectFrom('person_credentials')
            .select(['person_id', 'status', 'expires_on'])
            .where('org_id', '=', memberOrgId)
            .where('person_id', 'in', personIds)
            .execute()
        : [];
      const byPerson = new Map<string, typeof credentials>();
      for (const credential of credentials) {
        const list = byPerson.get(credential.person_id) ?? [];
        list.push(credential);
        byPerson.set(credential.person_id, list);
      }
      const today = new Date().toISOString().slice(0, 10);
      const rollup = (
        list: (typeof credentials)[number][] | undefined,
      ): {
        credentialStatus: 'cleared' | 'pending' | 'expired' | 'missing';
        expiresOn: string | null;
      } => {
        if (!list?.length) return { credentialStatus: 'missing', expiresOn: null };
        let hasPending = false;
        let hasExpired = false;
        let earliestExpiry: string | null = null;
        for (const credential of list) {
          const expiresOn = credential.expires_on
            ? new Date(credential.expires_on).toISOString().slice(0, 10)
            : null;
          if (
            (expiresOn && expiresOn < today) ||
            credential.status === 'expired' ||
            credential.status === 'revoked'
          )
            hasExpired = true;
          else if (credential.status !== 'verified') hasPending = true;
          if (expiresOn && (!earliestExpiry || expiresOn < earliestExpiry))
            earliestExpiry = expiresOn;
        }
        return {
          credentialStatus: hasExpired
            ? 'expired'
            : hasPending
              ? 'pending'
              : 'cleared',
          expiresOn: earliestExpiry,
        };
      };
      return {
        memberOrgId,
        staff: staff.map((row) => ({
          personRef: row.person_ref,
          firstName: row.first_name,
          lastName: row.last_name,
          role: row.role,
          teamName: row.display_name,
          ...rollup(byPerson.get(row.person_ref)),
        })),
      };
    },
  );
}

/**
 * Privileged read: a member club's federation-ready teams. Requires
 * `teamEntries` sharing.
 */
export async function readMemberTeams(
  context: OrgContext,
  memberOrgId: string,
): Promise<{
  memberOrgId: string;
  teams: {
    teamSeasonId: string;
    displayName: string;
    programName: string;
    divisionName: string;
    rosterSize: number;
  }[];
}> {
  return withFederationAccess(
    {
      requesting: context,
      sourceOrgId: memberOrgId,
      audit: {
        action: 'federation.cross_org.read',
        entityType: 'org_relationship',
        entityId: memberOrgId,
        requestingChanges: {
          dataset: { tier: 'internal', after: 'teamEntries' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'teamEntries' },
        },
      },
    },
    async (trx) => {
      const relationship = await assertActiveRelationship(
        trx,
        context.orgId,
        memberOrgId,
      );
      requireSharingKey(relationship, 'teamEntries');
      const rows = await trx
        .selectFrom('team_seasons')
        .innerJoin('programs', (join) =>
          join
            .onRef('programs.org_id', '=', 'team_seasons.org_id')
            .onRef('programs.id', '=', 'team_seasons.program_id'),
        )
        .innerJoin('divisions', (join) =>
          join
            .onRef('divisions.org_id', '=', 'team_seasons.org_id')
            .onRef('divisions.id', '=', 'team_seasons.division_id'),
        )
        .innerJoin('teams', (join) =>
          join
            .onRef('teams.org_id', '=', 'team_seasons.org_id')
            .onRef('teams.id', '=', 'team_seasons.team_id'),
        )
        .select([
          'team_seasons.id as team_season_id',
          'team_seasons.display_name',
          'teams.name as team_name',
          'programs.name as program_name',
          'divisions.name as division_name',
        ])
        .where('team_seasons.org_id', '=', memberOrgId)
        .where('team_seasons.status', 'in', ['forming', 'active'])
        .orderBy('programs.name')
        .limit(500)
        .execute();
      const rosterCounts = rows.length
        ? await trx
            .selectFrom('roster_entries')
            .select(['team_season_id'])
            .select((eb) => eb.fn.countAll().as('count'))
            .where('org_id', '=', memberOrgId)
            .where(
              'team_season_id',
              'in',
              rows.map((row) => row.team_season_id),
            )
            .where('status', '=', 'active')
            .groupBy('team_season_id')
            .execute()
        : [];
      const countByTeam = new Map(
        rosterCounts.map((row) => [row.team_season_id, Number(row.count)]),
      );
      return {
        memberOrgId,
        teams: rows.map((row) => ({
          teamSeasonId: row.team_season_id,
          displayName: row.display_name ?? row.team_name,
          programName: row.program_name,
          divisionName: row.division_name,
          rosterSize: countByTeam.get(row.team_season_id) ?? 0,
        })),
      };
    },
  );
}

/**
 * Privileged read: a member club's own discipline records that it shares.
 * Requires `discipline` sharing.
 */
export async function readMemberDiscipline(
  context: OrgContext,
  memberOrgId: string,
): Promise<{
  memberOrgId: string;
  records: {
    id: string;
    subjectName: string | null;
    type: string;
    status: string;
    suspensionGames: number | null;
    suspensionUntil: string | null;
    createdAt: string;
  }[];
}> {
  return withFederationAccess(
    {
      requesting: context,
      sourceOrgId: memberOrgId,
      audit: {
        action: 'federation.cross_org.read',
        entityType: 'org_relationship',
        entityId: memberOrgId,
        requestingChanges: {
          dataset: { tier: 'internal', after: 'discipline' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'discipline' },
        },
      },
    },
    async (trx) => {
      const relationship = await assertActiveRelationship(
        trx,
        context.orgId,
        memberOrgId,
      );
      requireSharingKey(relationship, 'discipline');
      const rows = await trx
        .selectFrom('discipline_records')
        .leftJoin('people', (join) =>
          join
            .onRef('people.org_id', '=', 'discipline_records.org_id')
            .onRef('people.id', '=', 'discipline_records.person_id'),
        )
        .leftJoin('team_seasons', (join) =>
          join
            .onRef('team_seasons.org_id', '=', 'discipline_records.org_id')
            .onRef('team_seasons.id', '=', 'discipline_records.team_season_id'),
        )
        .select([
          'discipline_records.id',
          'discipline_records.type',
          'discipline_records.status',
          'discipline_records.suspension_games',
          'discipline_records.suspension_until',
          'discipline_records.created_at',
          'people.first_name',
          'people.last_name',
          'team_seasons.display_name',
        ])
        .where('discipline_records.org_id', '=', memberOrgId)
        .orderBy('discipline_records.created_at', 'desc')
        .limit(200)
        .execute();
      return {
        memberOrgId,
        records: rows.map((row) => ({
          id: row.id,
          subjectName: row.first_name
            ? `${row.first_name} ${row.last_name ?? ''}`.trim()
            : (row.display_name ?? null),
          type: row.type,
          status: row.status,
          suspensionGames: row.suspension_games,
          suspensionUntil: row.suspension_until
            ? new Date(row.suspension_until).toISOString().slice(0, 10)
            : null,
          createdAt: row.created_at.toISOString(),
        })),
      };
    },
  );
}

export interface FederationProgramOption {
  programId: string;
  programName: string;
  mode: string;
  divisions: { divisionId: string; divisionName: string; ageLabel: string | null }[];
}

/** Own-org league programs + divisions for federation pickers. */
export async function listFederationPrograms(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<FederationProgramOption[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const programs = await trx
      .selectFrom('programs')
      .select(['id', 'name', 'mode'])
      .where('org_id', '=', context.orgId)
      .orderBy('name')
      .execute();
    if (!programs.length) return [];
    const divisions = await trx
      .selectFrom('divisions')
      .select(['id', 'program_id', 'name', 'age_label'])
      .where('org_id', '=', context.orgId)
      .where(
        'program_id',
        'in',
        programs.map((row) => row.id),
      )
      .orderBy('name')
      .execute();
    return programs.map((program) => ({
      programId: program.id,
      programName: program.name,
      mode: program.mode,
      divisions: divisions
        .filter((row) => row.program_id === program.id)
        .map((row) => ({
          divisionId: row.id,
          divisionName: row.name,
          ageLabel: row.age_label,
        })),
    }));
  });
}

/**
 * Privileged read: a league's programs + divisions so a member club can pick
 * one when submitting a team entry. Requires `teamEntries` sharing.
 */
export async function listLeagueProgramPicker(
  context: OrgContext,
  leagueOrgId: string,
): Promise<{ leagueOrgId: string; programs: FederationProgramOption[] }> {
  return withFederationAccess(
    {
      requesting: context,
      sourceOrgId: leagueOrgId,
      audit: {
        action: 'federation.cross_org.read',
        entityType: 'org_relationship',
        entityId: leagueOrgId,
        requestingChanges: {
          dataset: { tier: 'internal', after: 'teamEntries' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'teamEntries' },
        },
      },
    },
    async (trx) => {
      requireSharingKey(
        await assertActiveRelationship(trx, leagueOrgId, context.orgId),
        'teamEntries',
      );
      const programs = await trx
        .selectFrom('programs')
        .select(['id', 'name', 'mode'])
        .where('org_id', '=', leagueOrgId)
        .orderBy('name')
        .execute();
      if (!programs.length) return { leagueOrgId, programs: [] };
      const divisions = await trx
        .selectFrom('divisions')
        .select(['id', 'program_id', 'name', 'age_label'])
        .where('org_id', '=', leagueOrgId)
        .where(
          'program_id',
          'in',
          programs.map((row) => row.id),
        )
        .orderBy('name')
        .execute();
      return {
        leagueOrgId,
        programs: programs.map((program) => ({
          programId: program.id,
          programName: program.name,
          mode: program.mode,
          divisions: divisions
            .filter((row) => row.program_id === program.id)
            .map((row) => ({
              divisionId: row.id,
              divisionName: row.name,
              ageLabel: row.age_label,
            })),
        })),
      };
    },
  );
}

export interface OwnTeamSeasonOption {
  teamSeasonId: string;
  displayName: string;
  programName: string;
  divisionName: string | null;
  rosterSize: number;
}

/** Own-org team seasons with roster counts for the entry-submission picker. */
export async function listOwnTeamSeasons(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<OwnTeamSeasonOption[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const rows = await trx
      .selectFrom('team_seasons')
      .innerJoin('teams', (join) =>
        join
          .onRef('teams.org_id', '=', 'team_seasons.org_id')
          .onRef('teams.id', '=', 'team_seasons.team_id'),
      )
      .leftJoin('programs', (join) =>
        join
          .onRef('programs.org_id', '=', 'team_seasons.org_id')
          .onRef('programs.id', '=', 'team_seasons.program_id'),
      )
      .leftJoin('divisions', (join) =>
        join
          .onRef('divisions.org_id', '=', 'team_seasons.org_id')
          .onRef('divisions.id', '=', 'team_seasons.division_id'),
      )
      .select([
        'team_seasons.id',
        'team_seasons.display_name',
        'teams.name as team_name',
        'programs.name as program_name',
        'divisions.name as division_name',
      ])
      .where('team_seasons.org_id', '=', context.orgId)
      .orderBy('teams.name')
      .execute();
    const rosterCounts = rows.length
      ? await trx
          .selectFrom('roster_entries')
          .select(['team_season_id'])
          .select((eb) => eb.fn.countAll().as('count'))
          .where('org_id', '=', context.orgId)
          .where(
            'team_season_id',
            'in',
            rows.map((row) => row.id),
          )
          .where('status', '=', 'active')
          .groupBy('team_season_id')
          .execute()
      : [];
    const countByTeam = new Map(
      rosterCounts.map((row) => [row.team_season_id, Number(row.count)]),
    );
    return rows.map((row) => ({
      teamSeasonId: row.id,
      displayName: row.display_name ?? row.team_name,
      programName: row.program_name ?? 'Program',
      divisionName: row.division_name,
      rosterSize: countByTeam.get(row.id) ?? 0,
    }));
  });
}

export interface OwnSpaceOption {
  spaceId: string;
  spaceName: string;
  facilityName: string | null;
}

/** Own-org bookable spaces for the contribution picker. */
export async function listOwnSpaces(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<OwnSpaceOption[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const rows = await trx
      .selectFrom('spaces')
      .leftJoin('facilities', (join) =>
        join
          .onRef('facilities.org_id', '=', 'spaces.org_id')
          .onRef('facilities.id', '=', 'spaces.facility_id'),
      )
      .select(['spaces.id', 'spaces.name', 'facilities.name as facility_name'])
      .where('spaces.org_id', '=', context.orgId)
      .orderBy('spaces.name')
      .execute();
    return rows.map((row) => ({
      spaceId: row.id,
      spaceName: row.name,
      facilityName: row.facility_name,
    }));
  });
}

/** Federation-side relationship detail for either member. */
export async function getRelationshipFor(
  database: Kysely<DB>,
  context: OrgContext,
  relationshipId: string,
): Promise<FederationRelationship> {
  const withOrg = createWithOrg(database);
  const row = await withOrg(context, (trx) =>
    trx
      .selectFrom('org_relationships')
      .selectAll()
      .where('id', '=', relationshipId)
      .executeTakeFirst(),
  );
  if (!row) throw federationNotFound('Relationship not found');
  const orgNames = await database
    .selectFrom('organizations')
    .select(['id', 'name'])
    .where('id', 'in', [row.parent_org_id, row.child_org_id])
    .execute();
  const nameById = new Map(orgNames.map((org) => [org.id, org.name]));
  return {
    id: row.id,
    parentOrgId: row.parent_org_id,
    parentOrgName: nameById.get(row.parent_org_id) ?? 'Organization',
    childOrgId: row.child_org_id,
    childOrgName: nameById.get(row.child_org_id) ?? 'Organization',
    type: row.type as FederationRelationship['type'],
    initiator: row.initiator as FederationRelationship['initiator'],
    status: row.status as FederationRelationship['status'],
    dataSharing: federationSharingSchema.parse(row.data_sharing ?? {}),
    pendingDataSharing: row.pending_data_sharing
      ? federationSharingSchema.parse(row.pending_data_sharing)
      : null,
    note: row.note,
    respondedAt: row.responded_at?.toISOString() ?? null,
    suspendedAt: row.suspended_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}
