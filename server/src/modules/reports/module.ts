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
  reportScheduleUpdateSchema,
  savedReportBodySchema,
  savedReportCreateResponseSchema,
  savedReportListSchema,
  savedReportResponseSchema,
  savedReportUpdateSchema,
} from '@shared/schemas/reports';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createReportsRouter } from './routes';

export const moduleDefinition = {
  name: 'reports',
  path: '/api/v1/reports',
  router: createReportsRouter,
  jobs: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/reports/orgs/{orgId}/datasets',
      summary: 'List report datasets and columns available to the current role',
      response: reportDatasetListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/reports/orgs/{orgId}/reports/preview',
      summary: 'Preview a report with a 200-row maximum',
      body: reportPreviewBodySchema,
      response: reportPreviewResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/reports/orgs/{orgId}/reports/export',
      summary: 'Export a report as CSV or XLSX',
      body: reportExportBodySchema,
      response: z.string(),
      contentType: 'application/octet-stream',
      binary: true,
    },
    {
      method: 'get',
      path: '/api/v1/reports/orgs/{orgId}/saved-reports',
      summary: 'List saved reports visible to the current role',
      response: savedReportListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/reports/orgs/{orgId}/saved-reports',
      summary: 'Save a validated report definition',
      body: savedReportBodySchema,
      response: savedReportCreateResponseSchema,
      status: 201,
    },
    {
      method: 'get',
      path: '/api/v1/reports/orgs/{orgId}/saved-reports/{reportId}',
      summary: 'Get a saved report',
      response: savedReportResponseSchema,
    },
    {
      method: 'put',
      path: '/api/v1/reports/orgs/{orgId}/saved-reports/{reportId}',
      summary: 'Update a saved report with optimistic version checking',
      body: savedReportUpdateSchema,
      response: savedReportResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/reports/orgs/{orgId}/report-schedules',
      summary: 'List scheduled report deliveries',
      response: reportScheduleListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/reports/orgs/{orgId}/report-schedules',
      summary: 'Schedule a saved report for email delivery',
      body: reportScheduleBodySchema,
      response: reportScheduleCreateResponseSchema,
      status: 201,
    },
    {
      method: 'put',
      path: '/api/v1/reports/orgs/{orgId}/report-schedules/{scheduleId}',
      summary: 'Update or pause a scheduled report',
      body: reportScheduleUpdateSchema,
      response: reportScheduleUpdateResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/reports/orgs/{orgId}/saved-reports/{reportId}/export',
      summary: 'Export a saved report as CSV or XLSX',
      query: { format: reportExportQuerySchema.shape.format },
      response: z.string(),
      contentType: 'application/octet-stream',
      binary: true,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
