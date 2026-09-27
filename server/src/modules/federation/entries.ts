import { newId } from '@shared/ids';
import {
  rosterSnapshotPlayerSchema,
  type RosterSnapshotPlayer,
} from '@shared/schemas/federation';
import type { Kysely } from 'kysely';
import type { Transaction } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { requireVersion } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import {
  federationConflict,
  federationNotFound,
  federationUnprocessable,
} from './errors';
import {
  assertActiveRelationship,
  requireSharingKey,
  withFederationAccess,
  getFederationAdminDatabase,
} from './privileged';

export interface FederationEntryView {
  id: string;
  leagueOrgId: string;
  leagueOrgName: string;
  memberOrgId: string;
  memberOrgName: string;
  programId: string;
  programName: string;
  divisionId: string;
  divisionName: string;
  externalTeamId: string;
  teamName: string;
  status: string;
  seedHint: number | null;
  snapshot: {
    id: string;
    status: string;
    submittedAt: string;
    frozenAt: string | null;
    playerCount: number;
  } | null;
  createdAt: string;
  version: number;
}

interface StoredRosterSnapshotPlayer extends RosterSnapshotPlayer {
  /** Server-only reference, retained only when the athlete's media consent is granted. */
  photoFileId: string | null;
}

interface SnapshotEnvelope {
  captainPersonRef: string | null;
  players: StoredRosterSnapshotPlayer[];
}

interface PublicSnapshotEnvelope {
  captainPersonRef: string | null;
  players: RosterSnapshotPlayer[];
}

async function orgNames(
  trx: Transaction<DB>,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await trx
    .selectFrom('organizations')
    .select(['id', 'name'])
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}

function toEntryView(
  row: {
    id: string;
    org_id: string;
    program_id: string;
    division_id: string;
    external_team_id: string | null;
    entrant_org_id: string | null;
    status: string;
    seed_hint: number | null;
    created_at: Date;
    version: number;
    team_name?: string | null;
    program_name?: string | null;
    division_name?: string | null;
  },
  names: Map<string, string>,
  snapshot: {
    id: string;
    status: string;
    submitted_at: Date;
    frozen_at: Date | null;
    roster: unknown;
  } | null,
): FederationEntryView {
  const players = (snapshot?.roster as SnapshotEnvelope | undefined)?.players;
  return {
    id: row.id,
    leagueOrgId: row.org_id,
    leagueOrgName: names.get(row.org_id) ?? 'League',
    memberOrgId: row.entrant_org_id ?? '',
    memberOrgName: names.get(row.entrant_org_id ?? '') ?? 'Member club',
    programId: row.program_id,
    programName: row.program_name ?? 'Program',
    divisionId: row.division_id,
    divisionName: row.division_name ?? 'Division',
    externalTeamId: row.external_team_id ?? '',
    teamName: row.team_name ?? 'Team',
    status: row.status,
    seedHint: row.seed_hint,
    snapshot: snapshot
      ? {
          id: snapshot.id,
          status: snapshot.status,
          submittedAt: snapshot.submitted_at.toISOString(),
          frozenAt: snapshot.frozen_at?.toISOString() ?? null,
          playerCount: players?.length ?? 0,
        }
      : null,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

async function latestSnapshot(
  trx: Transaction<DB>,
  orgId: string,
  teamEntryId: string,
) {
  const row = await trx
    .selectFrom('federation_roster_snapshots')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('team_entry_id', '=', teamEntryId)
    .where('status', '<>', 'superseded')
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Club submits one of its own team_seasons into a league program. One
 * privileged transaction: validate the relationship, read the club roster
 * (allow-listed fields only), then create the league-side external_team,
 * team_entry and immutable roster snapshot — audited in both orgs.
 */
export async function submitEntry(
  context: OrgContext,
  input: {
    leagueOrgId: string;
    programId: string;
    divisionId: string;
    teamSeasonId: string;
    captainPersonId?: string | undefined;
    seedHint?: number | undefined;
    note?: string | undefined;
  },
): Promise<FederationEntryView> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    const relationship = await assertActiveRelationship(
      trx,
      input.leagueOrgId,
      context.orgId,
    );
    requireSharingKey(relationship, 'team_entries');
    // Source-side reads are scoped explicitly to the club org (admin bypasses
    // RLS — filters are mandatory).
    const teamSeason = await trx
      .selectFrom('team_seasons')
      .innerJoin('teams', (join) =>
        join
          .onRef('teams.org_id', '=', 'team_seasons.org_id')
          .onRef('teams.id', '=', 'team_seasons.team_id'),
      )
      .select([
        'team_seasons.id',
        'team_seasons.display_name',
        'team_seasons.status',
        'teams.name as team_name',
        'teams.sport_profile_id',
      ])
      .where('team_seasons.org_id', '=', context.orgId)
      .where('team_seasons.id', '=', input.teamSeasonId)
      .executeTakeFirst();
    if (!teamSeason || teamSeason.status === 'withdrawn')
      throw federationNotFound('Team season not found');
    const program = await trx
      .selectFrom('programs')
      .select(['id', 'sport_profile_id', 'name', 'status'])
      .where('org_id', '=', input.leagueOrgId)
      .where('id', '=', input.programId)
      .executeTakeFirst();
    if (!program || program.status === 'archived')
      throw federationNotFound('Program not found');
    if (program.sport_profile_id !== teamSeason.sport_profile_id) {
      // Sport profiles are per-org copies; compare by template name so a club
      // soccer team can enter a league soccer program.
      const [clubSport, leagueSport] = await Promise.all([
        trx
          .selectFrom('sport_profiles')
          .select(['name'])
          .where('org_id', '=', context.orgId)
          .where('id', '=', teamSeason.sport_profile_id)
          .executeTakeFirst(),
        trx
          .selectFrom('sport_profiles')
          .select(['name'])
          .where('org_id', '=', input.leagueOrgId)
          .where('id', '=', program.sport_profile_id)
          .executeTakeFirst(),
      ]);
      if (!clubSport || !leagueSport || clubSport.name !== leagueSport.name)
        throw federationUnprocessable('Team sport does not match the program');
    }
    const division = await trx
      .selectFrom('divisions')
      .select(['id', 'name', 'age_label'])
      .where('org_id', '=', input.leagueOrgId)
      .where('id', '=', input.divisionId)
      .where('program_id', '=', input.programId)
      .executeTakeFirst();
    if (!division) throw federationNotFound('Division not found');
    const window = await trx
      .selectFrom('federation_roster_windows')
      .selectAll()
      .where('org_id', '=', input.leagueOrgId)
      .where('program_id', '=', input.programId)
      .executeTakeFirst();
    if (window && new Date(window.submit_by) < new Date())
      throw federationUnprocessable(
        'The roster submission deadline has passed',
      );
    const offering = await trx
      .selectFrom('registration_offerings')
      .select(['id'])
      .where('org_id', '=', input.leagueOrgId)
      .where('program_id', '=', input.programId)
      .where('registrant_role', '=', 'team_entry')
      .where('active', '=', true)
      .where((eb) =>
        eb.or([
          eb('division_id', '=', input.divisionId),
          eb('division_id', 'is', null),
        ]),
      )
      .orderBy('division_id')
      .executeTakeFirst();
    if (!offering)
      throw federationUnprocessable(
        'The league has no open team-entry offering for this division',
      );
    const existing = await trx
      .selectFrom('team_entries')
      .innerJoin(
        'federation_roster_snapshots',
        'federation_roster_snapshots.team_entry_id',
        'team_entries.id',
      )
      .select('team_entries.id')
      .where('team_entries.org_id', '=', input.leagueOrgId)
      .where('team_entries.program_id', '=', input.programId)
      .where('team_entries.entrant_org_id', '=', context.orgId)
      .where('team_entries.status', 'not in', ['withdrawn', 'declined'])
      .where(
        'federation_roster_snapshots.source_team_season_id',
        '=',
        input.teamSeasonId,
      )
      .where('federation_roster_snapshots.status', '<>', 'superseded')
      .execute();
    if (existing.length)
      throw federationConflict(
        'This team already has a live entry in the program',
      );

    const rosterRows = await trx
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
        'people.media_consent',
        'people.photo_file_id',
        'roster_entries.jersey_number',
        'roster_entries.positions',
        'athlete_cards.card_number',
      ])
      .where('roster_entries.org_id', '=', context.orgId)
      .where('roster_entries.team_season_id', '=', input.teamSeasonId)
      .where('roster_entries.status', '=', 'active')
      .orderBy('people.last_name')
      .orderBy('people.first_name')
      .execute();
    const players: StoredRosterSnapshotPlayer[] = rosterRows.map((row) => ({
      personRef: row.person_ref,
      firstName: row.first_name,
      lastName: row.last_name,
      ageLabel: division.age_label,
      jerseyNumber: row.jersey_number,
      positions: row.positions,
      cardNumber: row.card_number,
      photoAvailable:
        row.media_consent === 'granted' && row.photo_file_id !== null,
      photoFileId: row.media_consent === 'granted' ? row.photo_file_id : null,
    }));
    const envelope: SnapshotEnvelope = {
      captainPersonRef: input.captainPersonId ?? null,
      players,
    };

    const externalTeamId = newId();
    const entryId = newId();
    const snapshotId = newId();
    await trx
      .insertInto('external_teams')
      .values({
        id: externalTeamId,
        org_id: input.leagueOrgId,
        name: teamSeason.display_name ?? teamSeason.team_name,
        club_name: null,
        sport_profile_id: program.sport_profile_id,
        age_label: division.age_label,
        linked_org_id: context.orgId,
      })
      .execute();
    await trx
      .insertInto('team_entries')
      .values({
        id: entryId,
        org_id: input.leagueOrgId,
        program_id: input.programId,
        division_id: input.divisionId,
        offering_id: offering.id,
        team_season_id: null,
        external_team_id: externalTeamId,
        entrant_org_id: context.orgId,
        captain_person_id: null,
        contact_account_id: context.actor.accountId,
        status: 'pending_approval',
        seed_hint: input.seedHint ?? null,
      })
      .execute();
    await trx
      .insertInto('federation_roster_snapshots')
      .values({
        id: snapshotId,
        org_id: input.leagueOrgId,
        team_entry_id: entryId,
        member_org_id: context.orgId,
        source_team_season_id: input.teamSeasonId,
        roster: JSON.parse(JSON.stringify(envelope)) as never,
        status: 'submitted',
        submitted_by: context.actor.accountId,
      })
      .execute();
    const actor = { accountId: context.actor.accountId };
    await appendAuditEvent(
      trx,
      { orgId: input.leagueOrgId, actor },
      {
        action: 'federation.entry.submitted',
        entityType: 'team_entry',
        entityId: entryId,
        changes: {
          memberOrgId: { tier: 'internal', after: context.orgId },
          programId: { tier: 'internal', after: input.programId },
          playerCount: { tier: 'internal', after: players.length },
        },
      },
    );
    await appendAuditEvent(
      trx,
      { orgId: context.orgId, actor },
      {
        action: 'federation.entry.submitted',
        entityType: 'team_entry',
        entityId: entryId,
        changes: {
          leagueOrgId: { tier: 'internal', after: input.leagueOrgId },
          programId: { tier: 'internal', after: input.programId },
          playerCount: { tier: 'internal', after: players.length },
        },
      },
    );
    const names = await orgNames(trx, [input.leagueOrgId, context.orgId]);
    const snapshot = await trx
      .selectFrom('federation_roster_snapshots')
      .selectAll()
      .where('id', '=', snapshotId)
      .executeTakeFirstOrThrow();
    return toEntryView(
      {
        id: entryId,
        org_id: input.leagueOrgId,
        program_id: input.programId,
        division_id: input.divisionId,
        external_team_id: externalTeamId,
        entrant_org_id: context.orgId,
        status: 'pending_approval',
        seed_hint: input.seedHint ?? null,
        created_at: new Date(),
        version: 1,
        team_name: teamSeason.display_name ?? teamSeason.team_name,
        program_name: program.name,
        division_name: division.name,
      },
      names,
      snapshot,
    );
  });
}

/** League lists federation entries in its programs. */
export async function listLeagueEntries(
  database: Kysely<DB>,
  context: OrgContext,
  programId?: string,
): Promise<FederationEntryView[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    let query = trx
      .selectFrom('team_entries')
      .innerJoin('external_teams', (join) =>
        join
          .onRef('external_teams.org_id', '=', 'team_entries.org_id')
          .onRef('external_teams.id', '=', 'team_entries.external_team_id'),
      )
      .innerJoin('programs', (join) =>
        join
          .onRef('programs.org_id', '=', 'team_entries.org_id')
          .onRef('programs.id', '=', 'team_entries.program_id'),
      )
      .innerJoin('divisions', (join) =>
        join
          .onRef('divisions.org_id', '=', 'team_entries.org_id')
          .onRef('divisions.id', '=', 'team_entries.division_id'),
      )
      .select([
        'team_entries.id',
        'team_entries.org_id',
        'team_entries.program_id',
        'team_entries.division_id',
        'team_entries.external_team_id',
        'team_entries.entrant_org_id',
        'team_entries.status',
        'team_entries.seed_hint',
        'team_entries.created_at',
        'team_entries.version',
        'external_teams.name as team_name',
        'programs.name as program_name',
        'divisions.name as division_name',
      ])
      .where('team_entries.entrant_org_id', 'is not', null)
      .orderBy('team_entries.created_at', 'desc');
    if (programId)
      query = query.where('team_entries.program_id', '=', programId);
    const rows = await query.execute();
    const names = await orgNames(
      trx,
      rows.flatMap((row) => [row.org_id, row.entrant_org_id ?? '']),
    );
    const views: FederationEntryView[] = [];
    for (const row of rows) {
      const snapshot = await latestSnapshot(trx, context.orgId, row.id);
      views.push(toEntryView(row, names, snapshot));
    }
    return views;
  });
}

/**
 * Club lists its own submissions held by league orgs — a privileged read
 * restricted to rows where entrant_org_id is the club. Audited in both orgs.
 */
export async function listClubEntries(
  context: OrgContext,
): Promise<FederationEntryView[]> {
  return withFederationAccess(
    {
      requesting: context,
      sourceOrgId: context.orgId,
      audit: {
        action: 'federation.cross_org.read',
        entityType: 'team_entry',
        entityId: context.orgId,
        requestingChanges: {
          dataset: { tier: 'internal', after: 'club_entries' },
        },
        sourceChanges: {
          dataset: { tier: 'internal', after: 'club_entries' },
        },
      },
    },
    async (trx) => {
      const relationships = await trx
        .selectFrom('org_relationships')
        .select('parent_org_id')
        .where('child_org_id', '=', context.orgId)
        .where('status', 'in', ['active', 'suspended'])
        .execute();
      const leagueIds = relationships.map((row) => row.parent_org_id);
      if (!leagueIds.length) return [];
      const rows = await trx
        .selectFrom('team_entries')
        .innerJoin('external_teams', (join) =>
          join
            .onRef('external_teams.org_id', '=', 'team_entries.org_id')
            .onRef('external_teams.id', '=', 'team_entries.external_team_id'),
        )
        .innerJoin('programs', (join) =>
          join
            .onRef('programs.org_id', '=', 'team_entries.org_id')
            .onRef('programs.id', '=', 'team_entries.program_id'),
        )
        .innerJoin('divisions', (join) =>
          join
            .onRef('divisions.org_id', '=', 'team_entries.org_id')
            .onRef('divisions.id', '=', 'team_entries.division_id'),
        )
        .select([
          'team_entries.id',
          'team_entries.org_id',
          'team_entries.program_id',
          'team_entries.division_id',
          'team_entries.external_team_id',
          'team_entries.entrant_org_id',
          'team_entries.status',
          'team_entries.seed_hint',
          'team_entries.created_at',
          'team_entries.version',
          'external_teams.name as team_name',
          'programs.name as program_name',
          'divisions.name as division_name',
        ])
        .where('team_entries.entrant_org_id', '=', context.orgId)
        .where('team_entries.org_id', 'in', leagueIds)
        .orderBy('team_entries.created_at', 'desc')
        .execute();
      const names = await orgNames(
        trx,
        rows.flatMap((row) => [row.org_id, context.orgId]),
      );
      const views: FederationEntryView[] = [];
      for (const row of rows) {
        const snapshot = await trx
          .selectFrom('federation_roster_snapshots')
          .selectAll()
          .where('org_id', '=', row.org_id)
          .where('team_entry_id', '=', row.id)
          .where('status', '<>', 'superseded')
          .executeTakeFirst();
        views.push(toEntryView(row, names, snapshot ?? null));
      }
      return views;
    },
  );
}

/** League reviews a pending entry (accept / waitlist / decline). */
export async function reviewEntry(
  database: Kysely<DB>,
  context: OrgContext,
  entryId: string,
  input: {
    action: 'accept' | 'waitlist' | 'decline';
    reason?: string | undefined;
    version: number;
  },
): Promise<{ id: string; status: string }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const entry = await trx
      .selectFrom('team_entries')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', entryId)
      .where('entrant_org_id', 'is not', null)
      .forUpdate()
      .executeTakeFirst();
    if (!entry) throw federationNotFound('Entry not found');
    requireVersion(entry, input.version);
    if (!['pending_approval', 'waitlisted'].includes(entry.status))
      throw federationConflict('Entry is not awaiting review');
    const status =
      input.action === 'accept'
        ? 'accepted'
        : input.action === 'waitlist'
          ? 'waitlisted'
          : 'declined';
    await trx
      .updateTable('team_entries')
      .set({ status, version: entry.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', entryId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: `federation.entry.${input.action === 'accept' ? 'accepted' : input.action === 'waitlist' ? 'waitlisted' : 'declined'}`,
      entityType: 'team_entry',
      entityId: entryId,
      changes: {
        status: { tier: 'internal', before: entry.status, after: status },
        memberOrgId: { tier: 'internal', after: entry.entrant_org_id },
        reason: { tier: 'internal', after: input.reason ?? null },
      },
    });
    return { id: entryId, status };
  });
}

/** Club withdraws its own submitted entry (privileged, audited both sides). */
export async function withdrawEntry(
  context: OrgContext,
  leagueOrgId: string,
  entryId: string,
): Promise<{ id: string; status: string }> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await assertActiveRelationship(trx, leagueOrgId, context.orgId);
    const entry = await trx
      .selectFrom('team_entries')
      .selectAll()
      .where('org_id', '=', leagueOrgId)
      .where('id', '=', entryId)
      .where('entrant_org_id', '=', context.orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!entry) throw federationNotFound('Entry not found');
    if (['withdrawn', 'declined'].includes(entry.status))
      throw federationConflict('Entry is already closed');
    await trx
      .updateTable('team_entries')
      .set({ status: 'withdrawn', version: entry.version + 1 })
      .where('org_id', '=', leagueOrgId)
      .where('id', '=', entryId)
      .execute();
    await trx
      .updateTable('federation_roster_snapshots')
      .set({ status: 'superseded' })
      .where('org_id', '=', leagueOrgId)
      .where('team_entry_id', '=', entryId)
      .where('status', '<>', 'superseded')
      .execute();
    const actor = { accountId: context.actor.accountId };
    for (const orgId of [leagueOrgId, context.orgId]) {
      await appendAuditEvent(
        trx,
        { orgId, actor },
        {
          action: 'federation.entry.withdrawn',
          entityType: 'team_entry',
          entityId: entryId,
          changes: {
            leagueOrgId: { tier: 'internal', after: leagueOrgId },
            memberOrgId: { tier: 'internal', after: context.orgId },
          },
        },
      );
    }
    return { id: entryId, status: 'withdrawn' };
  });
}

/** League fetches a full entry + live snapshot for review. */
export async function getLeagueEntry(
  database: Kysely<DB>,
  context: OrgContext,
  entryId: string,
): Promise<FederationEntryView & { roster: PublicSnapshotEnvelope | null }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const entry = await trx
      .selectFrom('team_entries')
      .innerJoin('external_teams', (join) =>
        join
          .onRef('external_teams.org_id', '=', 'team_entries.org_id')
          .onRef('external_teams.id', '=', 'team_entries.external_team_id'),
      )
      .innerJoin('programs', (join) =>
        join
          .onRef('programs.org_id', '=', 'team_entries.org_id')
          .onRef('programs.id', '=', 'team_entries.program_id'),
      )
      .innerJoin('divisions', (join) =>
        join
          .onRef('divisions.org_id', '=', 'team_entries.org_id')
          .onRef('divisions.id', '=', 'team_entries.division_id'),
      )
      .select([
        'team_entries.id',
        'team_entries.org_id',
        'team_entries.program_id',
        'team_entries.division_id',
        'team_entries.external_team_id',
        'team_entries.entrant_org_id',
        'team_entries.status',
        'team_entries.seed_hint',
        'team_entries.created_at',
        'team_entries.version',
        'external_teams.name as team_name',
        'programs.name as program_name',
        'divisions.name as division_name',
      ])
      .where('team_entries.id', '=', entryId)
      .where('team_entries.entrant_org_id', 'is not', null)
      .executeTakeFirst();
    if (!entry) throw federationNotFound('Entry not found');
    const snapshot = await trx
      .selectFrom('federation_roster_snapshots')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('team_entry_id', '=', entryId)
      .where('status', '<>', 'superseded')
      .executeTakeFirst();
    const names = await orgNames(trx, [
      entry.org_id,
      entry.entrant_org_id ?? '',
    ]);
    const savedRoster = snapshot?.roster as SnapshotEnvelope | undefined;
    return {
      ...toEntryView(entry, names, snapshot ?? null),
      roster: savedRoster
        ? {
            captainPersonRef: savedRoster.captainPersonRef,
            players: savedRoster.players.map(({ photoFileId, ...player }) =>
              rosterSnapshotPlayerSchema.parse({
                ...player,
                photoAvailable: player.photoAvailable && photoFileId !== null,
              }),
            ),
          }
        : null,
    };
  });
}

/** Club resubmits a roster snapshot before the league freeze. */
export async function resubmitRoster(
  context: OrgContext,
  leagueOrgId: string,
  entryId: string,
): Promise<{ id: string; playerCount: number }> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    const relationship = await assertActiveRelationship(
      trx,
      leagueOrgId,
      context.orgId,
    );
    requireSharingKey(relationship, 'team_entries');
    const entry = await trx
      .selectFrom('team_entries')
      .selectAll()
      .where('org_id', '=', leagueOrgId)
      .where('id', '=', entryId)
      .where('entrant_org_id', '=', context.orgId)
      .executeTakeFirst();
    if (!entry || ['withdrawn', 'declined'].includes(entry.status))
      throw federationNotFound('Entry not found');
    const prior = await trx
      .selectFrom('federation_roster_snapshots')
      .selectAll()
      .where('org_id', '=', leagueOrgId)
      .where('team_entry_id', '=', entryId)
      .where('status', '<>', 'superseded')
      .executeTakeFirst();
    if (!prior) throw federationNotFound('Roster snapshot not found');
    if (prior.status === 'frozen')
      throw federationUnprocessable('The roster is frozen by the league');
    const window = await trx
      .selectFrom('federation_roster_windows')
      .selectAll()
      .where('org_id', '=', leagueOrgId)
      .where('program_id', '=', entry.program_id)
      .executeTakeFirst();
    const deadline = window?.freeze_at ?? window?.submit_by;
    if (deadline && new Date(deadline) < new Date())
      throw federationUnprocessable('The roster window has closed');
    const division = await trx
      .selectFrom('divisions')
      .select(['age_label'])
      .where('org_id', '=', leagueOrgId)
      .where('id', '=', entry.division_id)
      .executeTakeFirst();
    const rosterRows = await trx
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
        'people.media_consent',
        'people.photo_file_id',
        'roster_entries.jersey_number',
        'roster_entries.positions',
        'athlete_cards.card_number',
      ])
      .where('roster_entries.org_id', '=', context.orgId)
      .where('roster_entries.team_season_id', '=', prior.source_team_season_id)
      .where('roster_entries.status', '=', 'active')
      .orderBy('people.last_name')
      .execute();
    const players: StoredRosterSnapshotPlayer[] = rosterRows.map((row) => ({
      personRef: row.person_ref,
      firstName: row.first_name,
      lastName: row.last_name,
      ageLabel: division?.age_label ?? null,
      jerseyNumber: row.jersey_number,
      positions: row.positions,
      cardNumber: row.card_number,
      photoAvailable:
        row.media_consent === 'granted' && row.photo_file_id !== null,
      photoFileId: row.media_consent === 'granted' ? row.photo_file_id : null,
    }));
    const snapshotId = newId();
    await trx
      .updateTable('federation_roster_snapshots')
      .set({ status: 'superseded', version: prior.version + 1 })
      .where('id', '=', prior.id)
      .execute();
    const captainPersonRef = (
      prior.roster as unknown as SnapshotEnvelope | undefined
    )?.captainPersonRef;
    await trx
      .insertInto('federation_roster_snapshots')
      .values({
        id: snapshotId,
        org_id: leagueOrgId,
        team_entry_id: entryId,
        member_org_id: context.orgId,
        source_team_season_id: prior.source_team_season_id,
        roster: JSON.parse(
          JSON.stringify({
            captainPersonRef: captainPersonRef ?? null,
            players,
          }),
        ) as never,
        status: 'submitted',
        submitted_by: context.actor.accountId,
      })
      .execute();
    const actor = { accountId: context.actor.accountId };
    for (const orgId of [leagueOrgId, context.orgId]) {
      await appendAuditEvent(
        trx,
        { orgId, actor },
        {
          action: 'federation.roster.resubmitted',
          entityType: 'team_entry',
          entityId: entryId,
          changes: {
            snapshotId: { tier: 'internal', after: snapshotId },
            playerCount: { tier: 'internal', after: players.length },
          },
        },
      );
    }
    return { id: snapshotId, playerCount: players.length };
  });
}

/** League declares the submission window for a program. */
export async function setRosterWindow(
  database: Kysely<DB>,
  context: OrgContext,
  programId: string,
  input: { submitBy: string; freezeAt?: string | null | undefined },
): Promise<{ programId: string; submitBy: string; freezeAt: string | null }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const program = await trx
      .selectFrom('programs')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', programId)
      .executeTakeFirst();
    if (!program) throw federationNotFound('Program not found');
    const existing = await trx
      .selectFrom('federation_roster_windows')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', programId)
      .executeTakeFirst();
    if (existing) {
      await trx
        .updateTable('federation_roster_windows')
        .set({
          submit_by: new Date(input.submitBy),
          freeze_at: input.freezeAt ? new Date(input.freezeAt) : null,
          version: existing.version + 1,
        })
        .where('id', '=', existing.id)
        .execute();
    } else {
      await trx
        .insertInto('federation_roster_windows')
        .values({
          id: newId(),
          org_id: context.orgId,
          program_id: programId,
          submit_by: new Date(input.submitBy),
          freeze_at: input.freezeAt ? new Date(input.freezeAt) : null,
          created_by: context.actor.accountId,
        })
        .execute();
    }
    await appendAuditEvent(trx, context, {
      action: 'federation.roster_window.set',
      entityType: 'program',
      entityId: programId,
      changes: {
        submitBy: { tier: 'internal', after: input.submitBy },
        freezeAt: { tier: 'internal', after: input.freezeAt ?? null },
      },
    });
    return {
      programId,
      submitBy: input.submitBy,
      freezeAt: input.freezeAt ?? null,
    };
  });
}

/** League freezes every live roster snapshot for a program. */
export async function freezeRosters(
  database: Kysely<DB>,
  context: OrgContext,
  programId: string,
): Promise<{ frozen: number }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const entries = await trx
      .selectFrom('team_entries')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', programId)
      .where('entrant_org_id', 'is not', null)
      .execute();
    if (!entries.length) return { frozen: 0 };
    const result = await trx
      .updateTable('federation_roster_snapshots')
      .set({ status: 'frozen', frozen_at: new Date() })
      .where('org_id', '=', context.orgId)
      .where(
        'team_entry_id',
        'in',
        entries.map((entry) => entry.id),
      )
      .where('status', '=', 'submitted')
      .executeTakeFirst();
    const frozen = Number(result.numUpdatedRows);
    await trx
      .updateTable('federation_roster_windows')
      .set({ freeze_at: new Date() })
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', programId)
      .where('freeze_at', 'is', null)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.rosters.frozen',
      entityType: 'program',
      entityId: programId,
      changes: { frozen: { tier: 'internal', after: frozen } },
    });
    return { frozen };
  });
}
