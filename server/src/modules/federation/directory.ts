import {
  federationSharingSchema,
  rosterSnapshotPlayerSchema,
} from '@shared/schemas/federation';
import type {
  FederationSharing,
  FederationRelationship,
  RosterSnapshotPlayer,
} from '@shared/schemas/federation';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import type { OrgContext } from '../../db/withOrg';
import { createWithOrg } from '../../db/withOrg';
import type { Storage } from '../../integrations/storage/storage';

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
  dataSharing: FederationSharing;
  teamCount: number | null;
  playerCount: number | null;
  compliancePercent: number | null;
  entryCounts: Record<string, number>;
  openDiscipline: number;
  outstandingFeeCents: number;
}

interface StoredRosterSnapshotPlayer extends RosterSnapshotPlayer {
  photoFileId: string | null;
}

interface StoredRosterSnapshot {
  captainPersonRef: string | null;
  players: StoredRosterSnapshotPlayer[];
}

/** League-side member club directory built from league-owned rows only. */
export async function listMembers(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<MemberSummary[]> {
  const withOrg = createWithOrg(database);
  const base = await withOrg(context, async (trx) => {
    const relationships = await trx
      .selectFrom('org_relationships')
      .select(['id', 'child_org_id', 'status', 'data_sharing'])
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
      .select(['id', 'entrant_org_id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('entrant_org_id', 'in', memberIds)
      .execute();
    const snapshots = await trx
      .selectFrom('federation_roster_snapshots as snapshot')
      .innerJoin('team_entries as entry', (join) =>
        join
          .onRef('entry.org_id', '=', 'snapshot.org_id')
          .onRef('entry.id', '=', 'snapshot.team_entry_id'),
      )
      .select(['entry.entrant_org_id', 'snapshot.roster'])
      .where('snapshot.org_id', '=', context.orgId)
      .where('snapshot.member_org_id', 'in', memberIds)
      .where('snapshot.status', '<>', 'superseded')
      .where('entry.entrant_org_id', 'in', memberIds)
      .where('entry.status', '=', 'accepted')
      .execute();
    const discipline = await trx
      .selectFrom('federation_discipline_records')
      .select(['member_org_id'])
      .where('org_id', '=', context.orgId)
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
      .where('fee.org_id', '=', context.orgId)
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
        dataSharing: federationSharingSchema.parse(
          relationship.data_sharing ?? {},
        ),
        teamCount: null,
        playerCount: null,
        compliancePercent: null,
        entryCounts,
        openDiscipline: discipline.filter(
          (row) => row.member_org_id === relationship.child_org_id,
        ).length,
        outstandingFeeCents: fees
          .filter((row) => row.member_org_id === relationship.child_org_id)
          .reduce((sum, row) => sum + (row.balance_cents ?? 0), 0),
        ...(federationSharingSchema.parse(relationship.data_sharing ?? {})
          .team_entries
          ? {
              teamCount: entries.filter(
                (entry) =>
                  entry.entrant_org_id === relationship.child_org_id &&
                  entry.status === 'accepted',
              ).length,
            }
          : {}),
        ...(federationSharingSchema.parse(relationship.data_sharing ?? {})
          .rosters
          ? {
              playerCount: snapshots
                .filter(
                  (snapshot) =>
                    snapshot.entrant_org_id === relationship.child_org_id,
                )
                .reduce((total, snapshot) => {
                  const players = (
                    snapshot.roster as { players?: unknown } | null
                  )?.players;
                  return total + (Array.isArray(players) ? players.length : 0);
                }, 0),
            }
          : {}),
      };
    });
  });
  return Promise.all(
    base.map(async (member) => {
      if (member.status !== 'active' || !member.dataSharing.compliance_status)
        return member;
      const compliance = await readMemberCompliance(
        context,
        member.memberOrgId,
      );
      const staffCount = compliance.staff.length;
      return {
        ...member,
        compliancePercent:
          staffCount === 0
            ? null
            : Math.round(
                (100 *
                  compliance.staff.filter(
                    (staff) => staff.credentialStatus === 'cleared',
                  ).length) /
                  staffCount,
              ),
      };
    }),
  );
}

/**
 * Privileged read: the immutable submitted roster snapshot for a member-club
 * team_season. Current media consent is rechecked before advertising a photo.
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
      const snapshot = await trx
        .selectFrom('federation_roster_snapshots as snapshot')
        .innerJoin('team_entries as entry', (join) =>
          join
            .onRef('entry.org_id', '=', 'snapshot.org_id')
            .onRef('entry.id', '=', 'snapshot.team_entry_id'),
        )
        .select(['snapshot.roster'])
        .where('snapshot.org_id', '=', context.orgId)
        .where('snapshot.member_org_id', '=', memberOrgId)
        .where('snapshot.source_team_season_id', '=', teamSeasonId)
        .where('snapshot.status', '<>', 'superseded')
        .where('entry.entrant_org_id', '=', memberOrgId)
        .orderBy('snapshot.submitted_at', 'desc')
        .executeTakeFirst();
      if (!snapshot) throw federationNotFound('Submitted roster not found');
      const saved = snapshot.roster as unknown as StoredRosterSnapshot;
      const candidatePlayers = saved.players;
      const candidates = candidatePlayers.filter(
        (player) => player.photoAvailable && player.photoFileId,
      );
      const currentPhotos = candidates.length
        ? await trx
            .selectFrom('people')
            .select(['id', 'photo_file_id'])
            .where('org_id', '=', memberOrgId)
            .where(
              'id',
              'in',
              candidates.map((player) => player.personRef),
            )
            .where('media_consent', '=', 'granted')
            .execute()
        : [];
      const permittedPhotoRefs = new Set(
        currentPhotos
          .filter((row) =>
            candidates.some(
              (player) =>
                player.personRef === row.id &&
                player.photoFileId === row.photo_file_id,
            ),
          )
          .map((row) => row.id),
      );
      return {
        teamSeasonId,
        players: candidatePlayers.map(({ photoFileId, ...player }) =>
          rosterSnapshotPlayerSchema.parse({
            ...player,
            photoAvailable:
              Boolean(photoFileId) && permittedPhotoRefs.has(player.personRef),
          }),
        ),
      };
    },
  );
}

/** A consent-gated roster image is returned only through this audited read. */
export async function readMemberPhoto(
  context: OrgContext,
  memberOrgId: string,
  teamSeasonId: string,
  personRef: string,
  storage: Storage,
): Promise<{
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}> {
  return withFederationAccess(
    {
      requesting: context,
      sourceOrgId: memberOrgId,
      audit: {
        action: 'federation.cross_org.read',
        entityType: 'person.photo',
        entityId: personRef,
        requestingChanges: {
          dataset: { tier: 'sensitive', after: 'consented roster photo' },
        },
        sourceChanges: {
          dataset: { tier: 'sensitive', after: 'consented roster photo' },
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
      const snapshot = await trx
        .selectFrom('federation_roster_snapshots as snapshot')
        .innerJoin('team_entries as entry', (join) =>
          join
            .onRef('entry.org_id', '=', 'snapshot.org_id')
            .onRef('entry.id', '=', 'snapshot.team_entry_id'),
        )
        .select(['snapshot.roster'])
        .where('snapshot.org_id', '=', context.orgId)
        .where('snapshot.member_org_id', '=', memberOrgId)
        .where('snapshot.source_team_season_id', '=', teamSeasonId)
        .where('snapshot.status', '<>', 'superseded')
        .where('entry.entrant_org_id', '=', memberOrgId)
        .orderBy('snapshot.submitted_at', 'desc')
        .executeTakeFirst();
      if (!snapshot)
        throw federationNotFound('Consented roster photo not found');
      const saved = snapshot.roster as unknown as StoredRosterSnapshot;
      const player = saved.players.find(
        (candidate) => candidate.personRef === personRef,
      );
      if (!player?.photoAvailable || !player.photoFileId)
        throw federationNotFound('Consented roster photo not found');
      const person = await trx
        .selectFrom('people')
        .select(['id'])
        .where('org_id', '=', memberOrgId)
        .where('id', '=', personRef)
        .where('photo_file_id', '=', player.photoFileId)
        .where('media_consent', '=', 'granted')
        .executeTakeFirst();
      if (!person) throw federationNotFound('Consented roster photo not found');
      const file = await trx
        .selectFrom('files')
        .select([
          'storage_key',
          'mime',
          'purpose',
          'sensitivity',
          'upload_state',
        ])
        .where('org_id', '=', memberOrgId)
        .where('id', '=', player.photoFileId)
        .executeTakeFirst();
      if (
        !file ||
        file.purpose !== 'image' ||
        file.sensitivity === 'restricted' ||
        file.upload_state !== 'complete' ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(file.mime)
      )
        throw federationNotFound('Consented roster photo not found');
      const object = await storage.get(file.storage_key);
      if (!object || object.bytes.byteLength > 4_500_000)
        throw federationNotFound('Consented roster photo not found');
      return {
        mimeType: file.mime as 'image/jpeg' | 'image/png' | 'image/webp',
        base64: Buffer.from(object.bytes).toString('base64'),
      };
    },
  );
}

/**
 * Privileged read: compliance status rollup for member-club team staff.
 * Requires `compliance_status` sharing. Returns derived statuses only —
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
          dataset: { tier: 'internal', after: 'compliance_status' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'compliance_status' },
        },
      },
    },
    async (trx) => {
      const relationship = await assertActiveRelationship(
        trx,
        context.orgId,
        memberOrgId,
      );
      requireSharingKey(relationship, 'compliance_status');
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
      } => {
        if (!list?.length) return { credentialStatus: 'missing' };
        let hasPending = false;
        let hasExpired = false;
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
        }
        return {
          credentialStatus: hasExpired
            ? 'expired'
            : hasPending
              ? 'pending'
              : 'cleared',
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
 * `team_entries` sharing.
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
          dataset: { tier: 'internal', after: 'team_entries' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'team_entries' },
        },
      },
    },
    async (trx) => {
      const relationship = await assertActiveRelationship(
        trx,
        context.orgId,
        memberOrgId,
      );
      requireSharingKey(relationship, 'team_entries');
      const rows = await trx
        .selectFrom('team_entries as entry')
        .innerJoin('external_teams as team', (join) =>
          join
            .onRef('team.org_id', '=', 'entry.org_id')
            .onRef('team.id', '=', 'entry.external_team_id'),
        )
        .innerJoin('programs as program', (join) =>
          join
            .onRef('program.org_id', '=', 'entry.org_id')
            .onRef('program.id', '=', 'entry.program_id'),
        )
        .innerJoin('divisions as division', (join) =>
          join
            .onRef('division.org_id', '=', 'entry.org_id')
            .onRef('division.id', '=', 'entry.division_id'),
        )
        .innerJoin('federation_roster_snapshots as snapshot', (join) =>
          join
            .onRef('snapshot.org_id', '=', 'entry.org_id')
            .onRef('snapshot.team_entry_id', '=', 'entry.id'),
        )
        .select([
          'snapshot.source_team_season_id',
          'team.name as team_name',
          'program.name as program_name',
          'division.name as division_name',
          'snapshot.roster',
        ])
        .where('entry.org_id', '=', context.orgId)
        .where('entry.entrant_org_id', '=', memberOrgId)
        .where('entry.status', '=', 'accepted')
        .where('snapshot.member_org_id', '=', memberOrgId)
        .where('snapshot.status', '<>', 'superseded')
        .orderBy('program.name')
        .limit(500)
        .execute();
      return {
        memberOrgId,
        teams: rows.map((row) => {
          const roster = row.roster as { players?: unknown } | null;
          return {
            teamSeasonId: row.source_team_season_id,
            displayName: row.team_name,
            programName: row.program_name,
            divisionName: row.division_name,
            rosterSize: Array.isArray(roster?.players)
              ? roster.players.length
              : 0,
          };
        }),
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
  divisions: {
    divisionId: string;
    divisionName: string;
    ageLabel: string | null;
  }[];
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
 * one when submitting a team entry. Requires `team_entries` sharing.
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
          dataset: { tier: 'internal', after: 'team_entries' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'team_entries' },
        },
      },
    },
    async (trx) => {
      requireSharingKey(
        await assertActiveRelationship(trx, leagueOrgId, context.orgId),
        'team_entries',
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
    pendingSharingByMe: row.pending_sharing_by === context.actor.accountId,
    note: row.note,
    respondedAt: row.responded_at?.toISOString() ?? null,
    suspendedAt: row.suspended_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}
