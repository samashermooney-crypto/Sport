import type { OrgTransaction } from '../../db/withOrg';

import { ReportError } from './query';

export interface ReportActorAccess {
  roles: string[];
  registrarMedicalAccess: boolean;
}

export async function loadReportActorAccess(
  trx: OrgTransaction,
  orgId: string,
  accountId: string,
): Promise<ReportActorAccess> {
  const membership = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', orgId)
    .where('account_id', '=', accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!membership) throw new ReportError(404, 'NOT_FOUND', 'Report not found');

  const assignments = await trx
    .selectFrom('role_assignments')
    .select('role')
    .where('org_id', '=', orgId)
    .where('account_id', '=', accountId)
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  const roles = [...new Set(assignments.map((assignment) => assignment.role))];
  if (roles.length === 0)
    throw new ReportError(404, 'NOT_FOUND', 'Report not found');

  const organization = await trx
    .selectFrom('organizations')
    .select('settings')
    .where('id', '=', orgId)
    .executeTakeFirst();
  const settings = organization?.settings;
  const registrarMedicalAccess =
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    'registrarMedicalAccess' in settings &&
    settings.registrarMedicalAccess === true;
  return { roles, registrarMedicalAccess };
}

export function canManageSavedReports(roles: readonly string[]): boolean {
  return roles.some((role) =>
    [
      'owner',
      'admin',
      'registrar',
      'finance',
      'scheduler',
      'compliance',
      'communications',
      'director',
      'evaluator',
      'volunteer_coordinator',
    ].includes(role),
  );
}

export function canViewSavedReport(
  accountId: string,
  roles: readonly string[],
  report: { created_by: string; shared_roles: readonly string[] },
): boolean {
  return (
    report.created_by === accountId ||
    roles.includes('owner') ||
    roles.includes('admin') ||
    report.shared_roles.some((role) => roles.includes(role))
  );
}

export function canEditSavedReport(
  accountId: string,
  roles: readonly string[],
  report: { created_by: string },
): boolean {
  return (
    report.created_by === accountId ||
    roles.includes('owner') ||
    roles.includes('admin')
  );
}
