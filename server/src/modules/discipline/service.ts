import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { ComplianceServiceError } from '../compliance/service';

const managerRoles = ['owner', 'admin', 'compliance'] as const;

async function canManage(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<boolean> {
  const role = await trx
    .selectFrom('role_assignments')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('role', 'in', [...managerRoles])
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .executeTakeFirst();
  return Boolean(role);
}

async function teamIdsForActor(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<string[]> {
  const rows = await trx
    .selectFrom('team_staff as staff')
    .innerJoin('person_account_links as link', (join) =>
      join
        .onRef('link.org_id', '=', 'staff.org_id')
        .onRef('link.person_id', '=', 'staff.person_id'),
    )
    .select('staff.team_season_id')
    .where('staff.org_id', '=', context.orgId)
    .where('staff.status', '=', 'active')
    .where('link.account_id', '=', context.actor.accountId)
    .where('link.relationship', '=', 'self')
    .where('link.revoked_at', 'is', null)
    .execute();
  return rows.map((row) => row.team_season_id);
}

export async function createDisciplineRecord(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    personId?: string | null;
    teamSeasonId?: string | null;
    contestId?: string | null;
    type:
      | 'caution'
      | 'send_off'
      | 'ejection'
      | 'technical'
      | 'suspension'
      | 'fine'
      | 'other';
    description: string;
    suspensionGames?: number | null;
    suspensionUntil?: string | null;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    if (!(await canManage(trx, context)))
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Discipline records not found',
      );
    if (!input.personId && !input.teamSeasonId)
      throw new ComplianceServiceError(
        400,
        'VALIDATION_ERROR',
        'Select a person or team for the discipline record',
      );
    if (input.teamSeasonId) {
      const team = await trx
        .selectFrom('team_seasons')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.teamSeasonId)
        .executeTakeFirst();
      if (!team)
        throw new ComplianceServiceError(404, 'NOT_FOUND', 'Team not found');
    }
    if (input.personId) {
      const person = await trx
        .selectFrom('people')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.personId)
        .executeTakeFirst();
      if (!person)
        throw new ComplianceServiceError(404, 'NOT_FOUND', 'Person not found');
      if (input.teamSeasonId) {
        const roster = await trx
          .selectFrom('roster_entries')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('person_id', '=', input.personId)
          .where('team_season_id', '=', input.teamSeasonId)
          .executeTakeFirst();
        if (!roster)
          throw new ComplianceServiceError(
            409,
            'NOT_ON_TEAM',
            'Person is not on the selected team',
          );
      }
    }
    if (input.contestId) {
      const contest = await trx
        .selectFrom('contests')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.contestId)
        .executeTakeFirst();
      if (!contest)
        throw new ComplianceServiceError(404, 'NOT_FOUND', 'Contest not found');
    }
    if (
      input.suspensionGames !== undefined &&
      input.suspensionGames !== null &&
      !['suspension', 'send_off', 'ejection', 'technical'].includes(input.type)
    )
      throw new ComplianceServiceError(
        400,
        'VALIDATION_ERROR',
        'Games can only be assigned to a suspension-type record',
      );
    const id = newId();
    await trx
      .insertInto('discipline_records')
      .values({
        id,
        org_id: context.orgId,
        person_id: input.personId ?? null,
        team_season_id: input.teamSeasonId ?? null,
        contest_id: input.contestId ?? null,
        type: input.type,
        description: input.description.trim(),
        suspension_games: input.suspensionGames ?? null,
        suspension_until: input.suspensionUntil
          ? new Date(input.suspensionUntil)
          : null,
        issued_by: context.actor.accountId,
        games_served: 0,
        status: 'active',
      })
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: 'discipline_record.created',
        entity_type: 'discipline_record',
        entity_id: id,
        changes: {
          personId: input.personId ?? null,
          teamSeasonId: input.teamSeasonId ?? null,
          contestId: input.contestId ?? null,
          type: input.type,
          description: '[redacted]',
          suspensionGames: input.suspensionGames ?? null,
          suspensionUntil: input.suspensionUntil ?? null,
        },
      })
      .execute();
    return { id, status: 'active', version: 1 };
  });
}

export async function listDisciplineRecords(
  database: Kysely<DB>,
  context: OrgContext,
  personId?: string,
) {
  return createWithOrg(database)(context, async (trx) => {
    const manager = await canManage(trx, context);
    const teams = manager ? [] : await teamIdsForActor(trx, context);
    if (!manager && teams.length === 0)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Discipline records not found',
      );
    let query = trx
      .selectFrom('discipline_records')
      .select([
        'id',
        'person_id as personId',
        'team_season_id as teamSeasonId',
        'contest_id as contestId',
        'type',
        'description',
        'suspension_games as suspensionGames',
        'suspension_until as suspensionUntil',
        'games_served as gamesServed',
        'status',
        'issued_by as issuedBy',
        'version',
        'created_at as createdAt',
      ])
      .where('org_id', '=', context.orgId);
    if (personId) query = query.where('person_id', '=', personId);
    if (!manager) query = query.where('team_season_id', 'in', teams);
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows;
  });
}

export async function updateDisciplineRecord(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    recordId: string;
    action: 'serve_games' | 'appeal' | 'overturn';
    games?: number;
    version: number;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    if (!(await canManage(trx, context)))
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Discipline record not found',
      );
    const row = await trx
      .selectFrom('discipline_records')
      .select(['id', 'status', 'games_served', 'suspension_games', 'version'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.recordId)
      .executeTakeFirst();
    if (!row)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Discipline record not found',
      );
    if (row.version !== input.version)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Discipline record changed; reload before updating',
      );
    let status = row.status;
    let gamesServed = row.games_served;
    if (input.action === 'serve_games') {
      if (
        row.status !== 'active' ||
        !row.suspension_games ||
        !input.games ||
        input.games < 1
      )
        throw new ComplianceServiceError(
          409,
          'INVALID_STATE',
          'This record has no remaining game suspension',
        );
      gamesServed = Math.min(
        row.suspension_games,
        row.games_served + input.games,
      );
      if (gamesServed >= row.suspension_games) status = 'served';
    } else if (input.action === 'appeal') {
      if (!['active', 'served'].includes(row.status))
        throw new ComplianceServiceError(
          409,
          'INVALID_STATE',
          'This record cannot be appealed',
        );
      status = 'appealed';
    } else {
      if (row.status !== 'appealed')
        throw new ComplianceServiceError(
          409,
          'INVALID_STATE',
          'Only an appealed record can be overturned',
        );
      status = 'overturned';
    }
    const updated = await trx
      .updateTable('discipline_records')
      .set({
        status,
        games_served: gamesServed,
        version: sql<number>`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.recordId)
      .where('version', '=', input.version)
      .returning(['id', 'status', 'games_served', 'version'])
      .executeTakeFirst();
    if (!updated)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Discipline record changed; reload before updating',
      );
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: `discipline_record.${input.action}`,
        entity_type: 'discipline_record',
        entity_id: input.recordId,
        changes: { status, gamesServed, action: input.action },
      })
      .execute();
    return {
      id: updated.id,
      status: updated.status,
      gamesServed: updated.games_served,
      version: updated.version,
    };
  });
}

export async function assertNotSuspendedForLineup(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
  teamSeasonId: string,
  onDate: Date,
): Promise<void> {
  const records = await trx
    .selectFrom('discipline_records')
    .select([
      'id',
      'description',
      'suspension_games',
      'suspension_until',
      'games_served',
      'status',
    ])
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .where('status', '=', 'active')
    .where((eb) =>
      eb.or([
        eb('team_season_id', 'is', null),
        eb('team_season_id', '=', teamSeasonId),
      ]),
    )
    .execute();
  const blocked = records.find(
    (record) =>
      (record.suspension_games !== null &&
        record.games_served < record.suspension_games) ||
      (record.suspension_until !== null &&
        record.suspension_until.getTime() >= onDate.getTime()),
  );
  if (blocked) {
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: 'discipline.lineup_blocked',
        entity_type: 'discipline_record',
        entity_id: blocked.id,
        changes: { personId, teamSeasonId, outcome: 'blocked' },
      })
      .execute();
    throw new ComplianceServiceError(
      409,
      'DISCIPLINE_SUSPENSION_ACTIVE',
      'This player has an active suspension',
    );
  }
}
