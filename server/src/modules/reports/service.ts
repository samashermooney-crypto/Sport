import { randomUUID } from 'node:crypto';

import type { DataTier, Dataset } from '@shared/reports/datasets';
import { canExportTier } from '@shared/reports/datasets';
import { orgRoleSchema } from '@shared/schemas/orgs';
import {
  reportDefinitionSchema,
  reportDatasetListSchema,
  savedReportBodySchema,
  savedReportListSchema,
  savedReportResponseSchema,
  savedReportUpdateSchema,
} from '@shared/schemas/reports';
import type { ReportDefinition } from '@shared/schemas/reports';

import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';

import {
  canEditSavedReport,
  canManageSavedReports,
  canViewSavedReport,
  loadReportActorAccess,
} from './policy';
import {
  columnsForActor,
  datasetAvailable,
  datasetForActor,
  reportUsesRestrictedColumns,
  reportDatasetCatalog,
  runDatasetQuery,
  validateReportDefinition,
} from './query';
import { ReportError } from './query';

export type ReportQueryResult = Awaited<ReturnType<typeof runDatasetQuery>>;

type ReportScheduleExportPolicy = {
  dataset: Dataset;
  definition: ReportDefinition;
  access: Awaited<ReturnType<typeof loadReportActorAccess>>;
  visibleColumns: ReturnType<typeof columnsForActor>;
};

function requireManager(
  roles: readonly string[],
  accountId: string,
  report?: { created_by: string },
): void {
  if (
    report
      ? !canEditSavedReport(accountId, roles, report)
      : !canManageSavedReports(roles)
  )
    throw new ReportError(
      403,
      'FORBIDDEN',
      'Report management access required',
    );
}

function normalizeSharedRoles(roles: readonly string[]): string[] {
  return roles.map((role) => orgRoleSchema.parse(role));
}

async function resolveDefinition(
  trx: OrgTransaction,
  roles: readonly string[],
  registrarMedicalAccess: boolean,
  definition: ReportDefinition,
) {
  const dataset = datasetForActor(definition.dataset, roles);
  if (!(await datasetAvailable(trx, dataset)))
    throw new ReportError(
      409,
      'DEPENDENCY_UNAVAILABLE',
      'This report dataset is not available yet',
    );
  const visible = columnsForActor(dataset, roles, { registrarMedicalAccess });
  validateReportDefinition(dataset, visible, definition);
  return { dataset, visible };
}

function usedColumns(dataset: Dataset, definition: ReportDefinition) {
  const keys = new Set([
    ...definition.columns,
    ...definition.filters.map((filter) => filter.column),
    ...definition.groupBy,
    ...definition.aggregates.map((aggregate) => aggregate.column),
  ]);
  return dataset.columns.filter((column) => keys.has(column.key));
}

function reportSummary(row: {
  id: string;
  name: string;
  definition: unknown;
  shared_roles: string[];
  is_preset: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}) {
  return savedReportResponseSchema.parse({
    id: row.id,
    name: row.name,
    definition: reportDefinitionSchema.parse(row.definition),
    sharedRoles: row.shared_roles,
    isPreset: row.is_preset,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

async function appendRestrictedReadAudit(
  trx: OrgTransaction,
  context: OrgContext,
  dataset: Dataset,
  definition: ReportDefinition,
): Promise<void> {
  const columns = reportUsesRestrictedColumns(dataset, definition);
  if (!columns.length) return;
  await appendAuditEvent(trx, context, {
    action: 'restricted.read',
    entityType: 'report_dataset',
    changes: {
      dataset_key: { tier: 'internal', after: dataset.key },
      ...Object.fromEntries(
        columns.map((column) => [
          column,
          { tier: 'restricted' as const, after: '[read]' },
        ]),
      ),
    },
  });
}

export async function listReportDatasets(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    const items = [];
    for (const dataset of reportDatasetCatalog) {
      if (!dataset.roles.some((role) => access.roles.includes(role))) continue;
      const available = await datasetAvailable(trx, dataset);
      items.push({
        key: dataset.key,
        label: dataset.label,
        description: dataset.description,
        available,
        columns: columnsForActor(dataset, access.roles, {
          registrarMedicalAccess: access.registrarMedicalAccess,
        }).map(({ key, label, type, tier }) => ({ key, label, type, tier })),
      });
    }
    return reportDatasetListSchema.parse({ items });
  });
}

export async function previewReport(
  context: OrgContext,
  definitionInput: unknown,
  runWithOrg: typeof withOrg = withOrg,
) {
  const definition = reportDefinitionSchema.parse(definitionInput);
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    const { dataset, visible } = await resolveDefinition(
      trx,
      access.roles,
      access.registrarMedicalAccess,
      definition,
    );
    const boundedDefinition = {
      ...definition,
      limit: Math.min(definition.limit ?? 200, 200),
    };
    const result = await runDatasetQuery(
      trx,
      context.orgId,
      dataset,
      boundedDefinition,
      columnsForActor(dataset, access.roles, {
        registrarMedicalAccess: access.registrarMedicalAccess,
      }).filter((column) => boundedDefinition.columns.includes(column.key)),
      visible,
    );
    await appendRestrictedReadAudit(trx, context, dataset, definition);
    return result;
  });
}

export async function exportReport(
  context: OrgContext,
  definitionInput: unknown,
  stepUpAuthenticated: boolean,
  runWithOrg: typeof withOrg = withOrg,
): Promise<ReportQueryResult> {
  const definition = reportDefinitionSchema.parse(definitionInput);
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    const { dataset, visible } = await resolveDefinition(
      trx,
      access.roles,
      access.registrarMedicalAccess,
      definition,
    );
    const referencedColumns = usedColumns(dataset, definition);
    if (
      referencedColumns.some(
        (column) =>
          !canExportTier(access.roles, column.tier, stepUpAuthenticated),
      )
    )
      throw new ReportError(
        stepUpAuthenticated ? 403 : 401,
        stepUpAuthenticated ? 'FORBIDDEN' : 'REAUTH_REQUIRED',
        stepUpAuthenticated
          ? 'Your role cannot export one or more selected columns'
          : 'Re-authenticate before exporting sensitive report data',
      );
    const result = await runDatasetQuery(
      trx,
      context.orgId,
      dataset,
      { ...definition, limit: Math.min(definition.limit ?? 50_000, 50_000) },
      columnsForActor(dataset, access.roles, {
        registrarMedicalAccess: access.registrarMedicalAccess,
      }).filter((column) => definition.columns.includes(column.key)),
      visible,
    );
    await appendRestrictedReadAudit(trx, context, dataset, definition);
    await appendAuditEvent(trx, context, {
      action: 'export.created',
      entityType: 'report',
      changes: {
        dataset_key: { tier: 'internal', after: dataset.key },
        format: { tier: 'internal', after: 'report_export' },
        row_count: { tier: 'internal', after: result.rows.length },
      },
    });
    return result;
  });
}

export async function reportExportPolicy(
  context: OrgContext,
  definitionInput: unknown,
  runWithOrg: typeof withOrg = withOrg,
): Promise<ReportScheduleExportPolicy> {
  const definition = reportDefinitionSchema.parse(definitionInput);
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    const { dataset, visible } = await resolveDefinition(
      trx,
      access.roles,
      access.registrarMedicalAccess,
      definition,
    );
    return { dataset, definition, access, visibleColumns: visible };
  });
}

export async function createSavedReport(
  context: OrgContext,
  input: unknown,
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = savedReportBodySchema.parse(input);
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    requireManager(access.roles, context.actor.accountId);
    const sharedRoles = normalizeSharedRoles(body.sharedRoles);
    await resolveDefinition(
      trx,
      access.roles,
      access.registrarMedicalAccess,
      body.definition,
    );
    const row = await trx
      .insertInto('saved_reports')
      .values({
        id: randomUUID(),
        org_id: context.orgId,
        name: body.name,
        dataset: body.definition.dataset,
        definition: body.definition as unknown as Json,
        created_by: context.actor.accountId,
        shared_roles: sharedRoles,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'saved_report.created',
      entityType: 'saved_report',
      entityId: row.id,
      changes: {
        name: { tier: 'internal', after: row.name },
        dataset: { tier: 'internal', after: row.dataset },
        shared_roles: {
          tier: 'internal',
          after: row.shared_roles,
        },
      },
    });
    return reportSummary(row);
  });
}

export async function listSavedReports(
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
      .selectFrom('saved_reports')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .orderBy('updated_at', 'desc')
      .limit(200)
      .execute();
    const items = rows
      .filter((row) =>
        canViewSavedReport(context.actor.accountId, access.roles, row),
      )
      .filter((row) => {
        try {
          datasetForActor(row.dataset, access.roles);
          return true;
        } catch {
          return false;
        }
      })
      .map(reportSummary);
    return savedReportListSchema.parse({ items });
  });
}

export async function getSavedReport(
  context: OrgContext,
  reportId: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    const row = await trx
      .selectFrom('saved_reports')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', reportId)
      .executeTakeFirst();
    if (!row || !canViewSavedReport(context.actor.accountId, access.roles, row))
      throw new ReportError(404, 'NOT_FOUND', 'Saved report not found');
    const definition = reportDefinitionSchema.parse(row.definition);
    await resolveDefinition(
      trx,
      access.roles,
      access.registrarMedicalAccess,
      definition,
    );
    return reportSummary(row);
  });
}

export async function updateSavedReport(
  context: OrgContext,
  reportId: string,
  input: unknown,
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = savedReportUpdateSchema.parse(input);
  return runWithOrg(context, async (trx) => {
    const access = await loadReportActorAccess(
      trx,
      context.orgId,
      context.actor.accountId,
    );
    const current = await trx
      .selectFrom('saved_reports')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', reportId)
      .executeTakeFirst();
    if (
      !current ||
      current.is_preset ||
      !canViewSavedReport(context.actor.accountId, access.roles, current)
    )
      throw new ReportError(404, 'NOT_FOUND', 'Saved report not found');
    requireManager(access.roles, context.actor.accountId, current);
    if (current.version !== body.expectedVersion)
      throw new ReportError(
        409,
        'CONFLICT',
        'This report changed; reload before updating',
      );
    const nextDefinition =
      body.definition ?? reportDefinitionSchema.parse(current.definition);
    await resolveDefinition(
      trx,
      access.roles,
      access.registrarMedicalAccess,
      nextDefinition,
    );
    const nextSharedRoles =
      body.sharedRoles === undefined
        ? current.shared_roles
        : normalizeSharedRoles(body.sharedRoles);
    const row = await trx
      .updateTable('saved_reports')
      .set({
        ...(body.name === undefined ? {} : { name: body.name }),
        dataset: nextDefinition.dataset,
        definition: nextDefinition as unknown as Json,
        shared_roles: nextSharedRoles,
        version: current.version + 1,
        updated_at: new Date(),
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', reportId)
      .where('version', '=', body.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new ReportError(
        409,
        'CONFLICT',
        'This report changed; reload before updating',
      );
    await appendAuditEvent(trx, context, {
      action: 'saved_report.updated',
      entityType: 'saved_report',
      entityId: row.id,
      changes: {
        name: {
          tier: 'internal',
          ...(body.name === undefined ? {} : { after: body.name }),
        },
        definition: { tier: 'internal', after: '[updated]' },
        shared_roles: {
          tier: 'internal',
          after: row.shared_roles,
        },
      },
    });
    return reportSummary(row);
  });
}

export function reportContainsTier(
  dataset: Dataset,
  definition: ReportDefinition,
  tier: DataTier,
): boolean {
  return usedColumns(dataset, definition).some(
    (column) => column.tier === tier,
  );
}

export function reportUsesOnlyInternalData(
  dataset: Dataset,
  definition: ReportDefinition,
): boolean {
  return usedColumns(dataset, definition).every(
    (column) => column.tier === 'public' || column.tier === 'internal',
  );
}
