import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createVolunteersRouter } from './routes';
import {
  myVolunteerHouseholdsSchema,
  shiftSignupListSchema,
  volunteerBuyoutBodySchema,
  volunteerBuyoutResponseSchema,
  volunteerLedgerSchema,
  volunteerRequirementBodySchema,
  volunteerRequirementListSchema,
  volunteerRoleBodySchema,
  volunteerRoleListSchema,
  volunteerRoleSchema,
  volunteerShiftBodySchema,
  volunteerShiftListSchema,
  volunteerSignupBodySchema,
  volunteerSignupSchema,
  volunteerStatusBodySchema,
} from './schema';

const base = '/api/v1/volunteers/orgs/{orgId}';
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
  tags: ['volunteers'],
  ...(body ? { body } : {}),
});

export const volunteerNotificationTemplates = {
  'volunteer.shift_reminder': {
    category: 'operational',
    defaultChannels: ['in_app', 'email'],
    preferenceKey: 'operational',
    en: {
      title: 'Volunteer shift reminder',
      body: 'Your volunteer shift starts tomorrow.',
    },
    es: {
      title: 'Recordatorio de turno voluntario',
      body: 'Tu turno voluntario comienza mañana.',
    },
  },
  'volunteer.requirement_behind': {
    category: 'operational',
    defaultChannels: ['in_app', 'email'],
    preferenceKey: 'operational',
    en: {
      title: 'Volunteer requirement update',
      body: 'Your household is behind on its volunteer requirement.',
    },
    es: {
      title: 'Actualización del requisito de voluntariado',
      body: 'Tu hogar está atrasado con el requisito de voluntariado.',
    },
  },
} as const;

const openapiRoutes = [
  route('get', '/roles', 'List volunteer roles', volunteerRoleListSchema),
  route(
    'post',
    '/roles',
    'Create a volunteer role',
    volunteerRoleSchema,
    volunteerRoleBodySchema,
  ),
  route(
    'get',
    '/requirements',
    'List volunteer requirements and scope',
    volunteerRequirementListSchema,
  ),
  route(
    'get',
    '/me/households',
    'List households the signed-in account can volunteer for',
    myVolunteerHouseholdsSchema,
  ),
  route(
    'post',
    '/requirements',
    'Create a household or athlete volunteer requirement',
    z.json(),
    volunteerRequirementBodySchema,
  ),
  route('get', '/shifts', 'List volunteer shifts', volunteerShiftListSchema),
  route(
    'get',
    '/shifts/{shiftId}/signups',
    'List signups for a shift with volunteer names',
    shiftSignupListSchema,
  ),
  route(
    'post',
    '/shifts',
    'Create a capacity-limited volunteer shift',
    z.json(),
    volunteerShiftBodySchema,
  ),
  route(
    'post',
    '/shifts/{shiftId}/signups',
    'Sign up a household member for a volunteer shift',
    volunteerSignupSchema,
    volunteerSignupBodySchema,
  ),
  route(
    'patch',
    '/signups/{signupId}',
    'Check in, credit, or close a signup',
    volunteerSignupSchema,
    volunteerStatusBodySchema,
  ),
  route(
    'get',
    '/households/{householdId}/ledger',
    'Read household volunteer progress',
    volunteerLedgerSchema,
  ),
  route(
    'post',
    '/requirements/{requirementId}/buyouts',
    'Issue a volunteer requirement buyout invoice',
    volunteerBuyoutResponseSchema,
    volunteerBuyoutBodySchema,
  ),
];

export const moduleDefinition = {
  name: 'volunteers',
  path: '/api/v1/volunteers',
  router: createVolunteersRouter,
  jobs: [],
  permissions: ['volunteers.read', 'volunteers.manage'],
  notificationTypes: Object.keys(volunteerNotificationTemplates),
  notificationTemplates: volunteerNotificationTemplates,
  errorCodes: [],
  openapiRoutes,
} satisfies ServerModule & {
  notificationTemplates: typeof volunteerNotificationTemplates;
  openapiRoutes: readonly unknown[];
};
