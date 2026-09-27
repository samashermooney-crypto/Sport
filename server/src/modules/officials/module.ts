import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createOfficialsRouter } from './routes';

const json = z.json();
const base = '/api/v1/officials';
const endpoints = [
  ['get', '/orgs/{orgId}/profiles', 'List official profiles'],
  [
    'put',
    '/orgs/{orgId}/profiles/{personId}',
    'Create or update an official profile',
  ],
  ['post', '/orgs/{orgId}/availability', 'Set official availability'],
  [
    'get',
    '/orgs/{orgId}/assignment-board',
    'View assignment candidates and conflicts',
  ],
  [
    'post',
    '/orgs/{orgId}/assignments',
    'Assign an official to a contest position',
  ],
  [
    'get',
    '/orgs/{orgId}/me/assignments',
    'List the current official assignments',
  ],
  [
    'post',
    '/orgs/{orgId}/me/contests/{contestId}/self-assign',
    'Self-assign to an open contest position',
  ],
  [
    'post',
    '/orgs/{orgId}/assignments/{assignmentId}/respond',
    'Accept or decline an assignment offer',
  ],
  [
    'post',
    '/orgs/{orgId}/assignments/{assignmentId}/confirm',
    'Confirm an official assignment',
  ],
  [
    'post',
    '/orgs/{orgId}/assignments/{assignmentId}/no-show',
    'Record an official no-show',
  ],
  [
    'post',
    '/orgs/{orgId}/contests/{contestId}/reports',
    'Submit an official game report',
  ],
  ['post', '/orgs/{orgId}/pay-batches', 'Create an officials pay batch'],
  [
    'post',
    '/orgs/{orgId}/pay-batches/{batchId}/approve',
    'Approve an officials pay batch',
  ],
  [
    'post',
    '/orgs/{orgId}/pay-batches/{batchId}/record-payment',
    'Record officials pay batch payment',
  ],
  [
    'get',
    '/orgs/{orgId}/payroll/yearly-totals',
    'Get yearly officials pay totals',
  ],
  [
    'get',
    '/orgs/{orgId}/payroll/yearly-totals.csv',
    'Export yearly officials pay as CSV',
  ],
] as const;
const openapiRoutes = endpoints.map(([method, path, summary]) => ({
  method,
  path: `${base}${path}`,
  summary,
  response: json,
  ...(['post', 'put', 'patch'].includes(method) ? { body: json } : {}),
  binary: path.endsWith('.csv'),
  tags: ['officials'],
}));

export const moduleDefinition = {
  name: 'officials',
  path: '/api/v1/officials',
  router: createOfficialsRouter,
  permissions: ['officials.manage', 'officials.self'],
  notificationTypes: [
    'official.assignment_offered',
    'official.assignment_responded',
    'official.assignment_confirmed',
  ],
  errorCodes: ['SCHEDULE_INVALID', 'SCHEDULE_CONFLICT'],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
