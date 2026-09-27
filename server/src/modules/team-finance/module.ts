import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createTeamFinanceRouter } from './routes';
import {
  reimbursementBodySchema,
  reimbursementDecisionSchema,
  reimbursementListSchema,
  reimbursementSchema,
  teamFeeAssessmentBodySchema,
  teamFeeAssessmentListSchema,
  teamFeeAssessmentSchema,
  teamFeeIssueResponseSchema,
  teamLedgerEntryBodySchema,
  teamLedgerListSchema,
  teamLedgerSchema,
} from './schema';
import { runTeamFeeLedgerJob } from './service';

const base = '/api/v1/team-finance/orgs/{orgId}';
const route = (
  method: 'get' | 'post' | 'patch',
  suffix: string,
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
) => ({
  method,
  path: `${base}${suffix}`,
  summary,
  response,
  tags: ['team-finance'],
  ...(body ? { body } : {}),
});

export const teamFinanceNotificationTemplates = {
  'team.fee_assessed': {
    category: 'operational',
    defaultChannels: ['in_app', 'email'],
    preferenceKey: 'operational',
    en: {
      title: 'Team fee invoice',
      body: 'A new team fee invoice is available.',
    },
    es: {
      title: 'Factura de cuota del equipo',
      body: 'Hay una nueva factura de cuota del equipo.',
    },
  },
  'team.reimbursement_decided': {
    category: 'operational',
    defaultChannels: ['in_app', 'email'],
    preferenceKey: 'operational',
    en: {
      title: 'Reimbursement update',
      body: 'Your team reimbursement request was reviewed.',
    },
    es: {
      title: 'Actualización de reembolso',
      body: 'Se revisó tu solicitud de reembolso del equipo.',
    },
  },
} as const;

const openapiRoutes = [
  route(
    'get',
    '/ledgers',
    'Club-wide team ledger balances and open items',
    teamLedgerListSchema,
  ),
  route(
    'get',
    '/teams/{teamSeasonId}/ledger',
    'Read a team ledger and balances',
    teamLedgerSchema,
  ),
  route(
    'post',
    '/teams/{teamSeasonId}/ledger/entries',
    'Post a finance-approved manual ledger entry',
    z.json(),
    teamLedgerEntryBodySchema,
  ),
  route(
    'get',
    '/teams/{teamSeasonId}/fee-assessments',
    'List team fee assessments',
    teamFeeAssessmentListSchema,
  ),
  route(
    'post',
    '/teams/{teamSeasonId}/fee-assessments',
    'Create a per-player team fee assessment',
    teamFeeAssessmentSchema,
    teamFeeAssessmentBodySchema,
  ),
  route(
    'post',
    '/fee-assessments/{assessmentId}/issue',
    'Issue team fee invoices through finance',
    teamFeeIssueResponseSchema,
  ),
  route(
    'get',
    '/teams/{teamSeasonId}/reimbursements',
    'List team reimbursement requests',
    reimbursementListSchema,
  ),
  route(
    'post',
    '/reimbursements',
    'Submit a receipt-backed reimbursement request',
    reimbursementSchema,
    reimbursementBodySchema,
  ),
  route(
    'patch',
    '/reimbursements/{reimbursementId}',
    'Approve or reject a reimbursement request',
    reimbursementSchema,
    reimbursementDecisionSchema,
  ),
];

export const moduleDefinition = {
  name: 'team-finance',
  path: '/api/v1/team-finance',
  router: createTeamFinanceRouter,
  jobs: [
    {
      name: 'team-finance.sync-paid-fees',
      cron: '* * * * *',
      run: runTeamFeeLedgerJob,
    },
  ],
  permissions: ['team-finance.read', 'team-finance.manage'],
  notificationTypes: Object.keys(teamFinanceNotificationTemplates),
  notificationTemplates: teamFinanceNotificationTemplates,
  errorCodes: [],
  openapiRoutes,
} satisfies ServerModule & {
  notificationTemplates: typeof teamFinanceNotificationTemplates;
  openapiRoutes: readonly unknown[];
};
