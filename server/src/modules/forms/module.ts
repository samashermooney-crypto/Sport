import {
  formAnswersSchema,
  formDefinitionCreateSchema,
  formDefinitionListSchema,
  formDefinitionSchema,
  formDefinitionUpdateSchema,
  formResponseSchema,
  formResponseSubmitSchema,
} from '@shared/schemas/forms';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createFormsRouter } from './routes';

const publishSchema = z.strictObject({ expectedVersion: z.int().positive() });

export const moduleDefinition = {
  name: 'forms',
  path: '/api/v1/forms',
  router: createFormsRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/forms/orgs/{orgId}',
      summary: 'List form definitions and versions for an organization',
      response: formDefinitionListSchema,
      tags: ['forms'],
    },
    {
      method: 'get',
      path: '/api/v1/forms/orgs/{orgId}/person',
      summary: 'List published profile forms for a linked person',
      query: { personId: z.uuid() },
      response: formDefinitionListSchema,
      tags: ['forms'],
    },
    {
      method: 'post',
      path: '/api/v1/forms/orgs/{orgId}',
      summary: 'Create a draft form definition',
      body: formDefinitionCreateSchema,
      response: formDefinitionSchema,
      status: 201,
      tags: ['forms'],
    },
    {
      method: 'patch',
      path: '/api/v1/forms/orgs/{orgId}/{formId}',
      summary: 'Update a draft or create the next form version',
      body: formDefinitionUpdateSchema,
      response: formDefinitionSchema,
      tags: ['forms'],
    },
    {
      method: 'post',
      path: '/api/v1/forms/orgs/{orgId}/{formId}/publish',
      summary: 'Publish a form version',
      body: publishSchema,
      response: formDefinitionSchema,
      tags: ['forms'],
    },
    {
      method: 'get',
      path: '/api/v1/forms/orgs/{orgId}/{formId}/reuse',
      summary: 'Read eligible profile-scoped answers for a published form',
      query: { personId: z.uuid() },
      response: formAnswersSchema,
      tags: ['forms'],
    },
    {
      method: 'post',
      path: '/api/v1/forms/orgs/{orgId}/responses',
      summary: 'Submit a form response with tiered-field encryption',
      body: formResponseSubmitSchema,
      response: formResponseSchema,
      status: 201,
      tags: ['forms'],
    },
    {
      method: 'get',
      path: '/api/v1/forms/orgs/{orgId}/responses/{responseId}',
      summary: 'Render a response with the exact form version it used',
      response: formResponseSchema,
      tags: ['forms'],
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
