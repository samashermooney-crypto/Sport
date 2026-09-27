import {
  householdCreateSchema,
  householdListSchema,
  householdMemberCreateSchema,
  householdResponseSchema,
  householdUpdateSchema,
} from '@shared/schemas/households';
import {
  peopleListSchema,
  personCreateSchema,
  personResponseSchema,
  personUpdateSchema,
} from '@shared/schemas/people';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createPeopleRouter } from './routes';

export const moduleDefinition = {
  name: 'people',
  path: '/api/v1/people',
  router: createPeopleRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/people/households/orgs/{orgId}',
      summary: 'List staff-visible households',
      response: householdListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/people/households/orgs/{orgId}/{householdId}',
      summary: 'Read household, members, registrations and balance',
      response: householdResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/people/households/orgs/{orgId}',
      summary: 'Create household',
      body: householdCreateSchema,
      response: householdResponseSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/people/households/orgs/{orgId}/{householdId}',
      summary: 'Versioned household update',
      body: householdUpdateSchema,
      response: householdResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/people/households/orgs/{orgId}/{householdId}/members',
      summary: 'Add household member',
      body: householdMemberCreateSchema,
      response: householdResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/people/orgs/{orgId}',
      summary: 'List and search staff-visible people',
      response: peopleListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/people/orgs/{orgId}/{personId}',
      summary: 'Read a person',
      response: personResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/people/orgs/{orgId}',
      summary: 'Create a person',
      body: personCreateSchema,
      response: personResponseSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/people/orgs/{orgId}/{personId}',
      summary: 'Versioned person update',
      body: personUpdateSchema,
      response: personResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/people/orgs/{orgId}/{personId}/archive',
      summary: 'Archive a person',
      body: z.strictObject({ expectedVersion: z.int().positive() }),
      response: personResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/people/orgs/{orgId}/{personId}/restore',
      summary: 'Restore an archived person',
      body: z.strictObject({ expectedVersion: z.int().positive() }),
      response: personResponseSchema,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
