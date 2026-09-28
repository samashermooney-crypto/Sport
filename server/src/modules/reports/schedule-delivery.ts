import { randomUUID } from 'node:crypto';

import { canExportTier } from '@shared/reports/datasets';
import { reportDefinitionSchema } from '@shared/schemas/reports';
import type { ReportDefinition } from '@shared/schemas/reports';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import {
  createMailpitEmailSender,
  createResendEmailSender,
} from '../../integrations/email/sender';
import type { EmailSender } from '../../integrations/email/sender';
import {
  sanitizeDownloadName,
  serializeReportCsv,
} from '../exports/report-serializers';
import { getPlatformAdminDatabase } from '../platform/admin';

import {
  canManageSavedReports,
  canViewSavedReport,
  loadReportActorAccess,
} from './policy';
import {
  columnsForActor,
  datasetAvailable,
  datasetForActor,
  ReportError,
  validateReportDefinition,
} from './query';
import { nextReportScheduleAt } from './schedule-time';
import { exportReport, reportUsesOnlyInternalData } from './service';
import type { ReportQueryResult } from './service';

const cadenceSchema = z.enum(['daily', 'weekly', 'monthly']);
const deliverySchema = z.enum(['link', 'csv_attachment']);
const formatSchema = z.enum(['csv', 'xlsx']);
const accountIdsSchema = z.array(z.uuid()).min(1).max(20);
const MAX_OUTBOX_ATTEMPTS = 8;
const OUTBOX_LEASE_MS = 10 * 60 * 1000;

type PendingOutbox = {
  id: string;
  schedule_id: string;
  scheduled_for: Date;
  attempts: number;
  lease_token: string;
};

type EligibleRecipient = {
  id: string;
  accountId: string;
  email: string;
};

type DeliveryPlan = {
  scheduleId: string;
  savedReportId: string;
  creatorId: string;
  reportName: string;
  definition: ReportDefinition;
  delivery: 'link' | 'csv_attachment';
  format: 'csv' | 'xlsx';
  eligible: EligibleRecipient[];
};

export type ScheduledReportDeliveryDependencies = {
  sender: EmailSender;
  appUrl: string;
  now?: () => Date;
  organizationIds?: readonly string[];
  adminDatabase?: Kysely<DB>;
  withOrg?: typeof withOrg;
};

export type ScheduledReportDeliveryCounts = {
  enqueued: number;
  sent: number;
  suppressed: number;
  failed: number;
};

function workerContext(orgId: string): OrgContext {
  return {
    orgId,
    actor: { accountId: '0199a1c0-0000-7000-8000-000000000001' },
  };
}

async function activeOrganizationIds(database: Kysely<DB>): Promise<string[]> {
  const rows = await database
    .selectFrom('organizations')
    .select('id')
    .where('status', '=', 'active')
    .orderBy('id')
    .execute();
  return rows.map(({ id }) => id);
}

async function enqueueDueSchedules(
  orgId: string,
  now: Date,
  runWithOrg: typeof withOrg,
): Promise<number> {
  return runWithOrg(workerContext(orgId), async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', orgId)
      .executeTakeFirst();
    if (!organization) return 0;

    const due = await trx
      .selectFrom('report_schedules')
      .select([
        'id',
        'cadence',
        'next_run_at',
        'run_at_minute',
        'run_on_day',
        'run_on_weekday',
        'version',
      ])
      .where('org_id', '=', orgId)
      .where('status', '=', 'active')
      .where('next_run_at', '<=', now)
      .orderBy('next_run_at', 'asc')
      .limit(100)
      .forUpdate()
      .skipLocked()
      .execute();

    for (const schedule of due) {
      const cadence = cadenceSchema.parse(schedule.cadence);
      const nextRunAt = nextReportScheduleAt({
        cadence,
        runAtMinute: schedule.run_at_minute,
        runOnDay: schedule.run_on_day,
        runOnWeekday: schedule.run_on_weekday,
        timezone: organization.timezone,
        after: schedule.next_run_at,
      });
      await trx
        .insertInto('report_delivery_outbox')
        .values({
          id: randomUUID(),
          org_id: orgId,
          schedule_id: schedule.id,
          scheduled_for: schedule.next_run_at,
          next_attempt_at: now,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['org_id', 'schedule_id', 'scheduled_for'])
            .doNothing(),
        )
        .execute();
      await trx
        .updateTable('report_schedules')
        .set({
          last_run_at: schedule.next_run_at,
          next_run_at: nextRunAt,
          version: schedule.version + 1,
        })
        .where('org_id', '=', orgId)
        .where('id', '=', schedule.id)
        .where('version', '=', schedule.version)
        .execute();
    }
    return due.length;
  });
}

async function claimOutbox(
  orgId: string,
  now: Date,
  runWithOrg: typeof withOrg,
): Promise<PendingOutbox | null> {
  return runWithOrg(workerContext(orgId), async (trx) => {
    const leaseToken = randomUUID();
    const result = await sql<PendingOutbox>`
      WITH candidate AS (
        SELECT id
        FROM report_delivery_outbox
        WHERE org_id = ${orgId}::uuid
          AND attempts < ${MAX_OUTBOX_ATTEMPTS}
          AND (
            (status IN ('queued', 'failed') AND next_attempt_at <= ${now})
            OR (status = 'sending' AND lease_until <= ${now})
          )
        ORDER BY next_attempt_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE report_delivery_outbox AS outbox
      SET status = 'sending', attempts = outbox.attempts + 1,
        lease_token = ${leaseToken}::uuid,
        lease_until = ${new Date(now.getTime() + OUTBOX_LEASE_MS)},
        last_error = NULL
      FROM candidate
      WHERE outbox.org_id = ${orgId}::uuid AND outbox.id = candidate.id
      RETURNING outbox.id, outbox.schedule_id, outbox.scheduled_for,
        outbox.attempts, outbox.lease_token
    `.execute(trx);
    return result.rows[0] ?? null;
  });
}

async function suppressPendingRecipients(
  trx: OrgTransaction,
  orgId: string,
  outboxId: string,
  reason: string,
): Promise<void> {
  await trx
    .updateTable('report_delivery_recipients')
    .set({ status: 'suppressed', last_error: reason })
    .where('org_id', '=', orgId)
    .where('outbox_id', '=', outboxId)
    .where('status', 'in', ['queued', 'failed', 'sending'])
    .execute();
}

async function prepareDeliveryPlan(
  orgId: string,
  outbox: PendingOutbox,
  runWithOrg: typeof withOrg,
): Promise<DeliveryPlan | null> {
  return runWithOrg(workerContext(orgId), async (trx) => {
    const schedule = await trx
      .selectFrom('report_schedules')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', outbox.schedule_id)
      .executeTakeFirst();
    if (!schedule) return null;

    const accountIds = accountIdsSchema.parse(schedule.recipients);
    for (const accountId of accountIds) {
      await trx
        .insertInto('report_delivery_recipients')
        .values({
          id: randomUUID(),
          org_id: orgId,
          outbox_id: outbox.id,
          account_id: accountId,
        })
        .onConflict((conflict) =>
          conflict.columns(['org_id', 'outbox_id', 'account_id']).doNothing(),
        )
        .execute();
    }
    await trx
      .updateTable('report_delivery_recipients')
      .set({
        status: 'suppressed',
        last_error: 'recipient_removed_from_schedule',
      })
      .where('org_id', '=', orgId)
      .where('outbox_id', '=', outbox.id)
      .where('account_id', 'not in', accountIds)
      .where('status', 'in', ['queued', 'failed', 'sending'])
      .execute();

    if (schedule.status !== 'active') {
      await suppressPendingRecipients(trx, orgId, outbox.id, 'schedule_paused');
      return {
        scheduleId: schedule.id,
        savedReportId: schedule.saved_report_id,
        creatorId: schedule.created_by,
        reportName: 'Scheduled report',
        definition: reportDefinitionSchema.parse({
          dataset: 'people',
          columns: ['id'],
        }),
        delivery: deliverySchema.parse(schedule.delivery),
        format: formatSchema.parse(schedule.format),
        eligible: [],
      };
    }

    const report = await trx
      .selectFrom('saved_reports')
      .select([
        'id',
        'name',
        'dataset',
        'definition',
        'created_by',
        'shared_roles',
      ])
      .where('org_id', '=', orgId)
      .where('id', '=', schedule.saved_report_id)
      .executeTakeFirst();
    if (!report) {
      await suppressPendingRecipients(
        trx,
        orgId,
        outbox.id,
        'report_unavailable',
      );
      return null;
    }

    const definition = reportDefinitionSchema.parse(report.definition);
    const delivery = deliverySchema.parse(schedule.delivery);
    const format = formatSchema.parse(schedule.format);
    let creatorAccess;
    try {
      creatorAccess = await loadReportActorAccess(
        trx,
        orgId,
        schedule.created_by,
      );
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      await suppressPendingRecipients(
        trx,
        orgId,
        outbox.id,
        'schedule_owner_access_changed',
      );
      return null;
    }

    if (!canManageSavedReports(creatorAccess.roles)) {
      await suppressPendingRecipients(
        trx,
        orgId,
        outbox.id,
        'schedule_owner_access_changed',
      );
      return null;
    }
    const dataset = datasetForActor(definition.dataset, creatorAccess.roles);
    if (
      report.dataset !== definition.dataset ||
      !(await datasetAvailable(trx, dataset)) ||
      !canViewSavedReport(schedule.created_by, creatorAccess.roles, report)
    ) {
      await suppressPendingRecipients(
        trx,
        orgId,
        outbox.id,
        'report_access_changed',
      );
      return null;
    }
    const creatorVisible = columnsForActor(dataset, creatorAccess.roles, {
      registrarMedicalAccess: creatorAccess.registrarMedicalAccess,
    });
    validateReportDefinition(dataset, creatorVisible, definition);
    if (
      delivery === 'csv_attachment' &&
      (format !== 'csv' || !reportUsesOnlyInternalData(dataset, definition))
    ) {
      await suppressPendingRecipients(
        trx,
        orgId,
        outbox.id,
        'attachment_policy_changed',
      );
      return null;
    }

    const members = await trx
      .selectFrom('org_memberships as membership')
      .innerJoin('accounts as account', 'account.id', 'membership.account_id')
      .select([
        'membership.account_id as account_id',
        'account.email as email',
        'account.email_verified_at as email_verified_at',
        'account.status as account_status',
      ])
      .where('membership.org_id', '=', orgId)
      .where('membership.status', '=', 'active')
      .where('membership.account_id', 'in', accountIds)
      .execute();
    const memberById = new Map(
      members.map((member) => [member.account_id, member]),
    );
    const pending = await trx
      .selectFrom('report_delivery_recipients')
      .select(['id', 'account_id', 'status'])
      .where('org_id', '=', orgId)
      .where('outbox_id', '=', outbox.id)
      .where('status', 'in', ['queued', 'failed', 'sending'])
      .execute();
    const eligible: EligibleRecipient[] = [];
    for (const recipient of pending) {
      const member = memberById.get(recipient.account_id);
      if (
        !member?.email ||
        !member.email_verified_at ||
        member.account_status !== 'active'
      ) {
        await trx
          .updateTable('report_delivery_recipients')
          .set({ status: 'suppressed', last_error: 'recipient_not_eligible' })
          .where('org_id', '=', orgId)
          .where('id', '=', recipient.id)
          .execute();
        continue;
      }
      try {
        const recipientAccess = await loadReportActorAccess(
          trx,
          orgId,
          recipient.account_id,
        );
        if (
          !canViewSavedReport(
            recipient.account_id,
            recipientAccess.roles,
            report,
          )
        )
          throw new ReportError(403, 'FORBIDDEN', 'Report access changed');
        const recipientDataset = datasetForActor(
          definition.dataset,
          recipientAccess.roles,
        );
        const visible = columnsForActor(
          recipientDataset,
          recipientAccess.roles,
          { registrarMedicalAccess: recipientAccess.registrarMedicalAccess },
        );
        validateReportDefinition(recipientDataset, visible, definition);
        if (
          delivery === 'csv_attachment' &&
          dataset.columns.some(
            (column) =>
              [
                ...definition.columns,
                ...definition.filters.map((filter) => filter.column),
                ...definition.groupBy,
                ...definition.aggregates.map((aggregate) => aggregate.column),
              ].includes(column.key) &&
              !canExportTier(recipientAccess.roles, column.tier, false),
          )
        )
          throw new ReportError(
            403,
            'FORBIDDEN',
            'Report export access changed',
          );
        eligible.push({
          id: recipient.id,
          accountId: recipient.account_id,
          email: member.email,
        });
      } catch (error) {
        if (!(error instanceof ReportError)) throw error;
        await trx
          .updateTable('report_delivery_recipients')
          .set({ status: 'suppressed', last_error: 'recipient_access_changed' })
          .where('org_id', '=', orgId)
          .where('id', '=', recipient.id)
          .execute();
      }
    }

    return {
      scheduleId: schedule.id,
      savedReportId: report.id,
      creatorId: schedule.created_by,
      reportName: report.name,
      definition,
      delivery,
      format,
      eligible,
    };
  });
}

async function setRecipientState(
  orgId: string,
  recipientId: string,
  runWithOrg: typeof withOrg,
  state: 'sending' | 'sent' | 'failed' | 'suppressed',
  details: { providerMessageId?: string; errorCode?: string } = {},
): Promise<void> {
  await runWithOrg(workerContext(orgId), async (trx) => {
    await trx
      .updateTable('report_delivery_recipients')
      .set({
        status: state,
        ...(state === 'sending' ? { attempts: sql<number>`attempts + 1` } : {}),
        provider_message_id: details.providerMessageId ?? null,
        last_error: details.errorCode ?? null,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', recipientId)
      .where('status', 'in', ['queued', 'failed', 'sending'])
      .execute();
  });
}

async function recipientStillSendable(
  orgId: string,
  scheduleId: string,
  recipientId: string,
  runWithOrg: typeof withOrg,
): Promise<boolean> {
  return runWithOrg(workerContext(orgId), async (trx) => {
    const schedule = await trx
      .selectFrom('report_schedules')
      .select('status')
      .where('org_id', '=', orgId)
      .where('id', '=', scheduleId)
      .executeTakeFirst();
    const recipient = await trx
      .selectFrom('report_delivery_recipients')
      .select('status')
      .where('org_id', '=', orgId)
      .where('id', '=', recipientId)
      .executeTakeFirst();
    return schedule?.status === 'active' && recipient?.status !== 'suppressed';
  });
}

async function finishOutbox(
  orgId: string,
  outbox: PendingOutbox,
  scheduleId: string,
  delivery: 'link' | 'csv_attachment',
  now: Date,
  runWithOrg: typeof withOrg,
): Promise<'sent' | 'suppressed' | 'failed'> {
  return runWithOrg(workerContext(orgId), async (trx) => {
    const recipients = await trx
      .selectFrom('report_delivery_recipients')
      .select('status')
      .where('org_id', '=', orgId)
      .where('outbox_id', '=', outbox.id)
      .execute();
    const sentCount = recipients.filter(
      (recipient) => recipient.status === 'sent',
    ).length;
    const failedCount = recipients.filter(
      (recipient) => recipient.status === 'failed',
    ).length;
    const pendingCount = recipients.filter((recipient) =>
      ['queued', 'sending'].includes(recipient.status),
    ).length;
    if (pendingCount > 0)
      throw new Error('Report delivery recipients were not finalized');

    const status =
      failedCount > 0 ? 'failed' : sentCount > 0 ? 'sent' : 'suppressed';
    const shouldRetry =
      status === 'failed' && outbox.attempts < MAX_OUTBOX_ATTEMPTS;
    const retryDelayMs = Math.min(
      15_000 * 2 ** Math.max(0, outbox.attempts - 1),
      6 * 60 * 60 * 1000,
    );
    await trx
      .insertInto('report_deliveries')
      .values({
        id: randomUUID(),
        org_id: orgId,
        schedule_id: scheduleId,
        sent_at: now,
        recipients_count: sentCount,
        delivery,
        status,
        error:
          status === 'failed'
            ? 'recipient_delivery_failed'
            : status === 'suppressed'
              ? 'no_currently_authorized_recipients'
              : null,
      })
      .execute();
    await trx
      .updateTable('report_delivery_outbox')
      .set({
        status,
        next_attempt_at: shouldRetry
          ? new Date(now.getTime() + retryDelayMs)
          : now,
        lease_token: null,
        lease_until: null,
        last_error: status === 'failed' ? 'recipient_delivery_failed' : null,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', outbox.id)
      .where('status', '=', 'sending')
      .where('lease_token', '=', outbox.lease_token)
      .execute();
    return status;
  });
}

async function recordBatchFailure(
  orgId: string,
  outbox: PendingOutbox,
  scheduleId: string,
  eligible: readonly EligibleRecipient[],
  now: Date,
  runWithOrg: typeof withOrg,
  suppress: boolean,
): Promise<'sent' | 'suppressed' | 'failed'> {
  for (const recipient of eligible)
    await setRecipientState(
      orgId,
      recipient.id,
      runWithOrg,
      suppress ? 'suppressed' : 'failed',
      {
        errorCode: suppress ? 'report_access_changed' : 'report_export_failed',
      },
    );
  return finishOutbox(
    orgId,
    outbox,
    scheduleId,
    'csv_attachment',
    now,
    runWithOrg,
  );
}

async function deliverOne(
  orgId: string,
  outbox: PendingOutbox,
  dependencies: ScheduledReportDeliveryDependencies,
  now: Date,
  runWithOrg: typeof withOrg,
): Promise<'sent' | 'suppressed' | 'failed'> {
  const plan = await prepareDeliveryPlan(orgId, outbox, runWithOrg);
  if (!plan) {
    return finishOutbox(
      orgId,
      outbox,
      outbox.schedule_id,
      'link',
      now,
      runWithOrg,
    );
  }
  if (plan.eligible.length === 0)
    return finishOutbox(
      orgId,
      outbox,
      plan.scheduleId,
      plan.delivery,
      now,
      runWithOrg,
    );

  let attachment: Uint8Array | undefined;
  let truncated = false;
  if (plan.delivery === 'csv_attachment') {
    try {
      const result: ReportQueryResult = await exportReport(
        { orgId, actor: { accountId: plan.creatorId } },
        plan.definition,
        false,
        runWithOrg,
      );
      attachment = serializeReportCsv(result);
      truncated = result.truncated;
    } catch (error) {
      const suppress =
        error instanceof ReportError &&
        [400, 401, 403, 404, 409].includes(error.status);
      return recordBatchFailure(
        orgId,
        outbox,
        plan.scheduleId,
        plan.eligible,
        now,
        runWithOrg,
        suppress,
      );
    }
  }

  const reportUrl = new URL(
    `/console/orgs/${orgId}/reports/${plan.savedReportId}`,
    dependencies.appUrl,
  ).toString();
  for (const recipient of plan.eligible) {
    if (
      !(await recipientStillSendable(
        orgId,
        plan.scheduleId,
        recipient.id,
        runWithOrg,
      ))
    ) {
      await setRecipientState(orgId, recipient.id, runWithOrg, 'suppressed', {
        errorCode: 'schedule_paused',
      });
      continue;
    }
    await setRecipientState(orgId, recipient.id, runWithOrg, 'sending');
    const attachmentNote =
      plan.delivery === 'csv_attachment' && truncated
        ? '\nThe attached export is limited to the first 50,000 rows.'
        : '';
    try {
      const sent = await dependencies.sender.send({
        to: recipient.email,
        subject: `Scheduled report: ${plan.reportName}`,
        text: `Your scheduled report is ready. Sign in to Athlentry to view it: ${reportUrl}${attachmentNote}`,
        kind: 'transactional',
        idempotencyKey: `report-schedule:${outbox.id}:${recipient.accountId}`,
        ...(attachment
          ? {
              attachments: [
                {
                  filename: `${sanitizeDownloadName(plan.reportName)}.csv`,
                  content: attachment,
                  contentType: 'text/csv; charset=utf-8',
                },
              ],
            }
          : {}),
      });
      await setRecipientState(orgId, recipient.id, runWithOrg, 'sent', {
        providerMessageId: sent.providerId,
      });
    } catch {
      await setRecipientState(orgId, recipient.id, runWithOrg, 'failed', {
        errorCode: 'email_provider_failure',
      });
    }
  }
  return finishOutbox(
    orgId,
    outbox,
    plan.scheduleId,
    plan.delivery,
    now,
    runWithOrg,
  );
}

export async function deliverScheduledReports(
  dependencies: ScheduledReportDeliveryDependencies,
): Promise<ScheduledReportDeliveryCounts> {
  const now = dependencies.now ?? (() => new Date());
  const runWithOrg = dependencies.withOrg ?? withOrg;
  const orgIds =
    dependencies.organizationIds ??
    (await activeOrganizationIds(
      dependencies.adminDatabase ?? getPlatformAdminDatabase(),
    ));
  const totals: ScheduledReportDeliveryCounts = {
    enqueued: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
  };
  for (const orgId of orgIds) {
    totals.enqueued += await enqueueDueSchedules(orgId, now(), runWithOrg);
    for (let index = 0; index < 100; index += 1) {
      const currentTime = now();
      const outbox = await claimOutbox(orgId, currentTime, runWithOrg);
      if (!outbox) break;
      const outcome = await deliverOne(
        orgId,
        outbox,
        dependencies,
        currentTime,
        runWithOrg,
      );
      totals[outcome] += 1;
    }
  }
  return totals;
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required for scheduled reports`);
  return value;
}

export async function runScheduledReportDeliveryJob(): Promise<ScheduledReportDeliveryCounts> {
  const live = process.env.DELIVERY_MODE === 'live';
  if (live && process.env.NODE_ENV !== 'production')
    throw new Error('Live scheduled report delivery requires production mode');
  const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:5173';
  if (live && new URL(appUrl).protocol !== 'https:')
    throw new Error('Live scheduled report links require HTTPS');
  const sender = live
    ? createResendEmailSender({
        apiKey: required('RESEND_API_KEY'),
        from: required('EMAIL_FROM'),
      })
    : createMailpitEmailSender();
  return deliverScheduledReports({
    sender,
    appUrl,
    adminDatabase: getPlatformAdminDatabase(),
  });
}
