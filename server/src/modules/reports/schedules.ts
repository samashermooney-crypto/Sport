import { randomUUID } from 'node:crypto';

import { datasetByKey } from '@shared/reports/datasets';
import {
  reportDefinitionSchema,
  reportScheduleBodySchema,
  reportScheduleListSchema,
  reportScheduleResponseSchema,
  reportScheduleUpdateSchema,
} from '@shared/schemas/reports';
import type { ReportScheduleBody } from '@shared/schemas/reports';
import type { ReportDefinition } from '@shared/schemas/reports';

import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';

import {
  canManageSavedReports,
  canViewSavedReport,
  loadReportActorAccess,
} from './policy';
import {
  columnsForActor,
  datasetAvailable,
  datasetForActor,
  validateReportDefinition,
} from './query';
import { ReportError } from './query';
import { nextReportScheduleAt, reportScheduleAnchor } from './schedule-time';
import { reportUsesOnlyInternalData } from './service';

type SavedReportRow = {
  id: string;
  dataset: string;
  definition: unknown;
  created_by: string;
  shared_roles: string[];
  is_preset: boolean;
};

type ScheduleRow = {
  id: string;
  org_id: string;
  saved_report_id: string;
  cadence: 'daily' | 'weekly' | 'monthly';
  run_at_minute: number;
  run_on_weekday: number | null;
  run_on_day: number | null;
  next_run_at: Date;
  recipients: unknown;
  delivery: 'link' | 'csv_attachment';
  format: 'csv' | 'xlsx';
  last_run_at: Date | null;
  status: 'active' | 'paused';
  created_by: string;
  version: number;
  created_at: Date;
};

function recipientIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new ReportError(
      500,
      'INTERNAL_ERROR',
      'Schedule recipients are invalid',
    );
  return value;
}

function scheduleSummary(row: ScheduleRow) {
  return reportScheduleResponseSchema.parse({
    id: row.id,
    savedReportId: row.saved_report_id,
    cadence: row.cadence,
    recipientAccountIds: recipientIds(row.recipients),
    delivery: row.delivery,
    format: row.format,
    runAtMinute: row.run_at_minute,
    status: row.status,
    nextRunAt: row.next_run_at.toISOString(),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    version: row.version,
    createdAt: row.created_at.toISOString(),
  });
}

async function loadAccessibleSavedReport(
  trx: OrgTransaction,
  context: OrgContext,
  roles: readonly string[],
  reportId: string,
): Promise<{ row: SavedReportRow; definition: ReportDefinition }> {
  const row = await trx
    .selectFrom('saved_reports')
    .select([
      'id',
      'dataset',
      'definition',
      'created_by',
      'shared_roles',
      'is_preset',
    ])
    .where('org_id', '=', context.orgId)
    .where('id', '=', reportId)
    .executeTakeFirst();
  if (!row || !canViewSavedReport(context.actor.accountId, roles, row))
    throw new ReportError(404, 'NOT_FOUND', 'Saved report not found');
  const definition = reportDefinitionSchema.parse(row.definition);
  if (row.dataset !== definition.dataset)
    throw new ReportError(
      500,
      'INTERNAL_ERROR',
      'Saved report dataset is invalid',
    );
  const dataset = datasetForActor(definition.dataset, roles);
  if (!(await datasetAvailable(trx, dataset)))
    throw new ReportError(
      409,
      'DEPENDENCY_UNAVAILABLE',
      'This report dataset is not available yet',
    );
  const visible = columnsForActor(dataset, roles);
  validateReportDefinition(dataset, visible, definition);
  return { row, definition };
}

async function validateRecipients(
  trx: OrgTransaction,
  context: OrgContext,
  body: ReportScheduleBody,
  report: SavedReportRow,
  definition: ReportDefinition,
): Promise<void> {
  const dataset = datasetByKey.get(definition.dataset);
  if (!dataset)
    throw new ReportError(404, 'NOT_FOUND', 'Report dataset not found');
  if (
    body.delivery === 'csv_attachment' &&
    (body.format !== 'csv' || !reportUsesOnlyInternalData(dataset, definition))
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'Scheduled CSV attachments are available only for Internal-tier report data',
    );

  const members = await trx
    .selectFrom('org_memberships')
    .innerJoin('accounts', 'accounts.id', 'org_memberships.account_id')
    .select([
      'org_memberships.account_id',
      'accounts.status as account_status',
      'accounts.email',
      'accounts.email_verified_at',
    ])
    .where('org_memberships.org_id', '=', context.orgId)
    .where('org_memberships.status', '=', 'active')
    .where('org_memberships.account_id', 'in', body.recipientAccountIds)
    .execute();
  if (
    members.length !== body.recipientAccountIds.length ||
    members.some(
      (member) =>
        member.account_status !== 'active' || member.email_verified_at === null,
    )
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'Every report recipient must be an active member with a verified email',
    );

  const assignments = await trx
    .selectFrom('role_assignments')
    .select(['account_id', 'role'])
    .where('org_id', '=', context.orgId)
    .where('account_id', 'in', body.recipientAccountIds)
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  const rolesByAccount = new Map<string, string[]>();
  for (const assignment of assignments) {
    const roles = rolesByAccount.get(assignment.account_id) ?? [];
    roles.push(assignment.role);
    rolesByAccount.set(assignment.account_id, roles);
  }
  for (const accountId of body.recipientAccountIds) {
    const roles = rolesByAccount.get(accountId) ?? [];
    const recipientAccess = await loadReportActorAccess(
      trx,
      context.orgId,
      accountId,
    );
    const recipientDataset = datasetForActor(definition.dataset, roles);
    const visible = columnsForActor(recipientDataset, recipientAccess.roles, {
      registrarMedicalAccess: recipientAccess.registrarMedicalAccess,
    });
    validateReportDefinition(recipientDataset, visible, definition);
    if (!canViewSavedReport(accountId, roles, report))
      throw new ReportError(
        400,
        'VALIDATION_ERROR',
        'Every report recipient must have access to the saved report',
      );
  }
}

export async function createReportSchedule(
  context: OrgContext,
  input: unknown,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = reportScheduleBodySchema.parse(input);
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    if (!canManageSavedReports(access.roles))
      throw new ReportError(
        403,
        'FORBIDDEN',
        'Report management access required',
      );
    const { row: report, definition } = await loadAccessibleSavedReport(
      trx,
      context,
      access.roles,
      body.savedReportId,
    );
    await validateRecipients(trx, context, body, report, definition);
    const organization = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', context.orgId)
      .executeTakeFirstOrThrow();
    const anchor = reportScheduleAnchor(
      body.cadence,
      now,
      organization.timezone,
    );
    const nextRunAt = nextReportScheduleAt({
      cadence: body.cadence,
      runAtMinute: body.runAtMinute,
      runOnDay: anchor.runOnDay,
      runOnWeekday: anchor.runOnWeekday,
      timezone: organization.timezone,
      after: now,
    });
    const row = await trx
      .insertInto('report_schedules')
      .values({
        id: randomUUID(),
        org_id: context.orgId,
        saved_report_id: report.id,
        cadence: body.cadence,
        run_at_minute: body.runAtMinute,
        run_on_weekday: anchor.runOnWeekday,
        run_on_day: anchor.runOnDay,
        next_run_at: nextRunAt,
        recipients: JSON.stringify(body.recipientAccountIds) as unknown as Json,
        delivery: body.delivery,
        format: body.format,
        created_by: context.actor.accountId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'report_schedule.created',
      entityType: 'report_schedule',
      entityId: row.id,
      changes: {
        saved_report_id: { tier: 'internal', after: report.id },
        cadence: { tier: 'internal', after: body.cadence },
        delivery: { tier: 'internal', after: body.delivery },
        recipients: {
          tier: 'internal',
          after: body.recipientAccountIds.length,
        },
      },
    });
    return scheduleSummary(row as ScheduleRow);
  });
}

export async function listReportSchedules(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    const rows = await trx
      .selectFrom('report_schedules')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
    const items = rows
      .filter(
        (row) =>
          row.created_by === context.actor.accountId ||
          access.roles.includes('owner') ||
          access.roles.includes('admin'),
      )
      .map((row) => scheduleSummary(row as ScheduleRow));
    return reportScheduleListSchema.parse({ items });
  });
}

export async function updateReportSchedule(
  context: OrgContext,
  scheduleId: string,
  input: unknown,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = reportScheduleUpdateSchema.parse(input);
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    const current = await trx
      .selectFrom('report_schedules')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', scheduleId)
      .executeTakeFirst();
    if (
      !current ||
      (current.created_by !== context.actor.accountId &&
        !access.roles.includes('owner') &&
        !access.roles.includes('admin'))
    )
      throw new ReportError(404, 'NOT_FOUND', 'Report schedule not found');
    if (!canManageSavedReports(access.roles))
      throw new ReportError(
        403,
        'FORBIDDEN',
        'Report management access required',
      );
    if (current.version !== body.expectedVersion)
      throw new ReportError(
        409,
        'CONFLICT',
        'This schedule changed; reload before updating',
      );
    const nextBody = reportScheduleBodySchema.parse({
      savedReportId: current.saved_report_id,
      cadence: body.cadence ?? current.cadence,
      recipientAccountIds:
        body.recipientAccountIds ?? recipientIds(current.recipients),
      delivery: body.delivery ?? current.delivery,
      format: body.format ?? current.format,
      runAtMinute: body.runAtMinute ?? current.run_at_minute,
    });
    const { row: report, definition } = await loadAccessibleSavedReport(
      trx,
      context,
      access.roles,
      current.saved_report_id,
    );
    await validateRecipients(trx, context, nextBody, report, definition);
    const organization = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', context.orgId)
      .executeTakeFirstOrThrow();
    const cadenceChanged = body.cadence !== undefined;
    const anchor = cadenceChanged
      ? reportScheduleAnchor(nextBody.cadence, now, organization.timezone)
      : {
          runOnDay: current.run_on_day,
          runOnWeekday: current.run_on_weekday,
        };
    const nextStatus = body.status ?? current.status;
    const timeChanged =
      body.runAtMinute !== undefined || body.cadence !== undefined;
    const nextRunAt =
      nextStatus === 'active' && (current.status === 'paused' || timeChanged)
        ? nextReportScheduleAt({
            cadence: nextBody.cadence,
            runAtMinute: nextBody.runAtMinute,
            runOnDay: anchor.runOnDay,
            runOnWeekday: anchor.runOnWeekday,
            timezone: organization.timezone,
            after: now,
          })
        : current.next_run_at;
    const row = await trx
      .updateTable('report_schedules')
      .set({
        cadence: nextBody.cadence,
        run_at_minute: nextBody.runAtMinute,
        run_on_weekday: anchor.runOnWeekday,
        run_on_day: anchor.runOnDay,
        recipients: JSON.stringify(
          nextBody.recipientAccountIds,
        ) as unknown as Json,
        delivery: nextBody.delivery,
        format: nextBody.format,
        status: nextStatus,
        next_run_at: nextRunAt,
        version: current.version + 1,
        updated_at: now,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', scheduleId)
      .where('version', '=', body.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new ReportError(
        409,
        'CONFLICT',
        'This schedule changed; reload before updating',
      );
    if (nextStatus === 'paused')
      await trx
        .updateTable('report_delivery_outbox')
        .set({ status: 'suppressed', lease_token: null, lease_until: null })
        .where('org_id', '=', context.orgId)
        .where('schedule_id', '=', scheduleId)
        .where('status', 'in', ['queued', 'failed'])
        .execute();
    await appendAuditEvent(trx, context, {
      action: 'report_schedule.updated',
      entityType: 'report_schedule',
      entityId: row.id,
      changes: {
        cadence: { tier: 'internal', after: row.cadence },
        status: { tier: 'internal', after: row.status },
        delivery: { tier: 'internal', after: row.delivery },
        recipients: {
          tier: 'internal',
          after: nextBody.recipientAccountIds.length,
        },
      },
    });
    return scheduleSummary(row as ScheduleRow);
  });
}
