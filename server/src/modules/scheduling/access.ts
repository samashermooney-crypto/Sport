import type { OrgContext, OrgTransaction } from '../../db/withOrg';

export type SchedulePermission =
  | 'schedule.read'
  | 'schedule.manage'
  | 'results.read'
  | 'results.manage'
  | 'attendance.read'
  | 'attendance.manage'
  | 'attendance.rsvp'
  | 'officials.manage'
  | 'officials.self'
  | 'tournaments.manage';

export type ResourceScope = {
  programId?: string;
  divisionId?: string;
  teamSeasonId?: string;
  personId?: string;
};

export class ScheduleAccessError extends Error {
  constructor(
    message = 'The requested schedule resource is unavailable',
    readonly status: 403 | 404 = 403,
  ) {
    super(message);
  }
}

const roleMap: Record<SchedulePermission, readonly string[]> = {
  'schedule.read': [
    'owner',
    'admin',
    'scheduler',
    'director',
    'reporter',
    'registrar',
  ],
  'schedule.manage': ['owner', 'admin', 'scheduler'],
  'results.read': ['owner', 'admin', 'scheduler', 'director', 'reporter'],
  'results.manage': ['owner', 'admin', 'scheduler'],
  'attendance.read': ['owner', 'admin', 'scheduler', 'director', 'reporter'],
  'attendance.manage': ['owner', 'admin', 'scheduler', 'director'],
  'attendance.rsvp': [],
  'officials.manage': ['owner', 'admin', 'scheduler'],
  'officials.self': [],
  'tournaments.manage': ['owner', 'admin', 'scheduler'],
};

function roleCoversScope(
  role: {
    role: string;
    scope_type: string;
    scope_id: string | null;
  },
  scope: ResourceScope,
): boolean {
  if (role.scope_type === 'org') return role.scope_id === null;
  if (role.scope_type === 'program')
    return Boolean(scope.programId && role.scope_id === scope.programId);
  if (role.scope_type === 'division')
    return Boolean(scope.divisionId && role.scope_id === scope.divisionId);
  if (role.scope_type === 'team_season')
    return Boolean(scope.teamSeasonId && role.scope_id === scope.teamSeasonId);
  return false;
}

export async function assertSchedulePermission(
  trx: OrgTransaction,
  context: OrgContext,
  permission: SchedulePermission,
  scope: ResourceScope = {},
): Promise<void> {
  const membership = await trx
    .selectFrom('org_memberships')
    .select('status')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .executeTakeFirst();
  if (membership?.status !== 'active') throw new ScheduleAccessError();

  const roles = await trx
    .selectFrom('role_assignments')
    .select(['role', 'scope_type', 'scope_id'])
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  if (
    roles.some(
      (role) =>
        roleMap[permission].includes(role.role) && roleCoversScope(role, scope),
    )
  )
    return;

  const linkedPeople = await trx
    .selectFrom('person_account_links')
    .select('person_id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('revoked_at', 'is', null)
    .where('verified_at', 'is not', null)
    .execute();
  const personIds = linkedPeople.map((link) => link.person_id);

  if (
    permission === 'attendance.rsvp' &&
    scope.personId &&
    personIds.includes(scope.personId)
  )
    return;

  if (
    (permission === 'attendance.read' ||
      permission === 'schedule.read' ||
      permission === 'results.read') &&
    scope.personId &&
    personIds.includes(scope.personId)
  )
    return;

  const coachPermission =
    permission === 'attendance.read' ||
    permission === 'attendance.manage' ||
    permission === 'results.manage' ||
    permission === 'schedule.read';
  if (coachPermission && scope.teamSeasonId && personIds.length) {
    const staff = await trx
      .selectFrom('team_staff')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', scope.teamSeasonId)
      .where('person_id', 'in', personIds)
      .where('role', 'in', [
        'head_coach',
        'assistant_coach',
        'team_manager',
        'trainer',
      ])
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (staff) return;
  }

  if (
    (permission === 'schedule.read' || permission === 'results.read') &&
    scope.teamSeasonId &&
    personIds.length
  ) {
    const roster = await trx
      .selectFrom('roster_entries')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', scope.teamSeasonId)
      .where('person_id', 'in', personIds)
      .where('status', 'in', ['active', 'injured', 'suspended'])
      .executeTakeFirst();
    if (roster) return;
  }

  if (permission === 'officials.self' && scope.personId) {
    if (personIds.includes(scope.personId)) return;
  }
  throw new ScheduleAccessError();
}
