import { apiErrorSchema } from '@shared/schemas/errors';
import {
  reportDatasetListSchema,
  reportExportBodySchema,
  reportExportQuerySchema,
  reportPreviewBodySchema,
  reportPreviewResponseSchema,
  reportScheduleBodySchema,
  reportScheduleCreateResponseSchema,
  reportScheduleListSchema,
  reportScheduleUpdateResponseSchema,
  savedReportBodySchema,
  savedReportCreateResponseSchema,
  savedReportListSchema,
  savedReportResponseSchema,
  savedReportUpdateSchema,
} from '@shared/schemas/reports';
import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';
import { hasStepUp } from '../auth/sessions';
import {
  serializeReportCsv,
  serializeReportXlsx,
  sanitizeDownloadName,
} from '../exports/report-serializers';

import { buildBoardSeasonReportPdf } from './board-report';
import { ReportError } from './query';
import {
  createReportSchedule,
  listReportSchedules,
  updateReportSchedule,
} from './schedules';
import {
  createSavedReport,
  exportReport,
  getSavedReport,
  listReportDatasets,
  listSavedReports,
  previewReport,
  updateSavedReport,
} from './service';

const reportIdSchema = z.uuid();

function mutationOriginIsValid(
  request: express.Request,
  appUrl: string,
): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && request.get('Origin') === undefined))
  );
}

function requestContext(orgId: string, accountId: string): OrgContext {
  return { orgId, actor: { accountId } };
}

async function sessionContext(
  dependencies: AuthDependencies,
  request: express.Request,
) {
  const session = await requireSession(dependencies, request);
  const orgId = z.uuid().parse(request.params.orgId);
  return {
    session,
    context: requestContext(orgId, session.accountId),
  };
}

function sendError(response: express.Response, error: unknown): void {
  const status =
    error instanceof z.ZodError || error instanceof RangeError
      ? 400
      : error &&
          typeof error === 'object' &&
          'status' in error &&
          typeof error.status === 'number'
        ? error.status
        : 500;
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code in
      {
        VALIDATION_ERROR: true,
        NOT_FOUND: true,
        UNAUTHENTICATED: true,
        REAUTH_REQUIRED: true,
        FORBIDDEN: true,
        CONFLICT: true,
        DEPENDENCY_UNAVAILABLE: true,
      }
      ? error.code
      : status === 400
        ? 'VALIDATION_ERROR'
        : status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 409
                ? 'CONFLICT'
                : status === 503
                  ? 'DEPENDENCY_UNAVAILABLE'
                  : 'INTERNAL_ERROR';
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code,
        message:
          status >= 500
            ? 'The request could not be completed'
            : error instanceof Error
              ? error.message
              : 'Request failed',
      },
    }),
  );
}

function withErrorHandling(
  handler: (
    request: express.Request,
    response: express.Response,
  ) => Promise<void>,
) {
  return (request: express.Request, response: express.Response) => {
    void handler(request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  };
}

function requireMutationOrigin(
  request: express.Request,
  response: express.Response,
  dependencies: AuthDependencies,
): boolean {
  if (mutationOriginIsValid(request, dependencies.appUrl)) return true;
  sendError(
    response,
    new ReportError(403, 'FORBIDDEN', 'Request origin is not allowed'),
  );
  return false;
}

function sendFile(
  response: express.Response,
  name: string,
  format: 'csv' | 'xlsx',
  table: Parameters<typeof serializeReportCsv>[0],
): void {
  const safeName = sanitizeDownloadName(name);
  const bytes =
    format === 'csv' ? serializeReportCsv(table) : serializeReportXlsx(table);
  const contentType =
    format === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', contentType);
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeName}.${format}"`,
  );
  response.send(Buffer.from(bytes));
}

export function createReportsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  const withOrg = createWithOrg(dependencies.database);

  router.get(
    '/orgs/:orgId/datasets',
    withErrorHandling(async (request, response) => {
      const { context } = await sessionContext(dependencies, request);
      const result = await listReportDatasets(context, withOrg);
      response.setHeader('Cache-Control', 'no-store');
      response.json(reportDatasetListSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/board-report.pdf',
    withErrorHandling(async (request, response) => {
      const { session, context } = await sessionContext(dependencies, request);
      const pdf = await buildBoardSeasonReportPdf(context, {
        stepUpAuthenticated: hasStepUp(session, dependencies.clock()),
      });
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader(
        'Content-Disposition',
        'attachment; filename="board-season-summary.pdf"',
      );
      response.send(Buffer.from(pdf));
    }),
  );

  router.post(
    '/orgs/:orgId/reports/preview',
    withErrorHandling(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { context } = await sessionContext(dependencies, request);
      const body = reportPreviewBodySchema.parse(request.body);
      const result = await previewReport(context, body.definition, withOrg);
      response.setHeader('Cache-Control', 'no-store');
      response.json(reportPreviewResponseSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/reports/export',
    withErrorHandling(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { session, context } = await sessionContext(dependencies, request);
      const body = reportExportBodySchema.parse(request.body);
      const result = await exportReport(
        context,
        body.definition,
        hasStepUp(session, dependencies.clock()),
        withOrg,
      );
      const datasetName = body.definition.dataset.replaceAll('_', '-');
      sendFile(response, datasetName, body.format, result);
    }),
  );

  router.get(
    '/orgs/:orgId/saved-reports',
    withErrorHandling(async (request, response) => {
      const { context } = await sessionContext(dependencies, request);
      const result = await listSavedReports(context, withOrg);
      response.setHeader('Cache-Control', 'no-store');
      response.json(savedReportListSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/saved-reports',
    withErrorHandling(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { context } = await sessionContext(dependencies, request);
      const body = savedReportBodySchema.parse(request.body);
      const result = await createSavedReport(context, body, withOrg);
      response
        .status(201)
        .json(savedReportCreateResponseSchema.parse({ report: result }));
    }),
  );

  router.get(
    '/orgs/:orgId/saved-reports/:reportId/export',
    withErrorHandling(async (request, response) => {
      const { session, context } = await sessionContext(dependencies, request);
      const reportId = reportIdSchema.parse(request.params.reportId);
      const query = reportExportQuerySchema.parse(request.query);
      const saved = await getSavedReport(context, reportId, withOrg);
      const result = await exportReport(
        context,
        saved.definition,
        hasStepUp(session, dependencies.clock()),
        withOrg,
      );
      sendFile(response, saved.name, query.format, result);
    }),
  );

  router.get(
    '/orgs/:orgId/saved-reports/:reportId',
    withErrorHandling(async (request, response) => {
      const { context } = await sessionContext(dependencies, request);
      const reportId = reportIdSchema.parse(request.params.reportId);
      const result = await getSavedReport(context, reportId, withOrg);
      response.setHeader('Cache-Control', 'no-store');
      response.json(savedReportResponseSchema.parse(result));
    }),
  );

  router.put(
    '/orgs/:orgId/saved-reports/:reportId',
    withErrorHandling(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { context } = await sessionContext(dependencies, request);
      const reportId = reportIdSchema.parse(request.params.reportId);
      const body = savedReportUpdateSchema.parse(request.body);
      const result = await updateSavedReport(context, reportId, body, withOrg);
      response.json(savedReportResponseSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/report-schedules',
    withErrorHandling(async (request, response) => {
      const { context } = await sessionContext(dependencies, request);
      const result = await listReportSchedules(context, withOrg);
      response.setHeader('Cache-Control', 'no-store');
      response.json(reportScheduleListSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/report-schedules',
    withErrorHandling(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { context } = await sessionContext(dependencies, request);
      const body = reportScheduleBodySchema.parse(request.body);
      const schedule = await createReportSchedule(
        context,
        body,
        dependencies.clock(),
        withOrg,
      );
      response
        .status(201)
        .json(reportScheduleCreateResponseSchema.parse({ schedule }));
    }),
  );

  router.put(
    '/orgs/:orgId/report-schedules/:scheduleId',
    withErrorHandling(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { context } = await sessionContext(dependencies, request);
      const scheduleId = reportIdSchema.parse(request.params.scheduleId);
      const schedule = await updateReportSchedule(
        context,
        scheduleId,
        request.body,
        dependencies.clock(),
        withOrg,
      );
      response.json(reportScheduleUpdateResponseSchema.parse({ schedule }));
    }),
  );

  return router;
}
