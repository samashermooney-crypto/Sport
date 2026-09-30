import {
  waiverDocumentCreateSchema,
  waiverDocumentListSchema,
  waiverDocumentSchema,
  waiverDocumentUpdateSchema,
  waiverDocumentVersionActionSchema,
  waiverSignatureCreateSchema,
  waiverSignatureListSchema,
  waiverSignatureSchema,
} from '@shared/schemas/waivers';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createWaiversRouter } from './routes';

export const moduleDefinition = {
  name: 'waivers',
  path: '/api/v1/waivers',
  router: createWaiversRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/waivers/orgs/{orgId}',
      summary: 'List waiver documents and immutable versions',
      response: waiverDocumentListSchema,
      tags: ['waivers'],
    },
    {
      method: 'get',
      path: '/api/v1/waivers/orgs/{orgId}/person',
      summary: 'List published waivers for a linked person',
      query: { personId: z.uuid() },
      response: waiverDocumentListSchema,
      tags: ['waivers'],
    },
    {
      method: 'post',
      path: '/api/v1/waivers/orgs/{orgId}',
      summary: 'Create a draft waiver from plain text',
      body: waiverDocumentCreateSchema,
      response: waiverDocumentSchema,
      status: 201,
      tags: ['waivers'],
    },
    {
      method: 'patch',
      path: '/api/v1/waivers/orgs/{orgId}/{waiverId}',
      summary: 'Update a draft or create the next waiver version',
      body: waiverDocumentUpdateSchema,
      response: waiverDocumentSchema,
      tags: ['waivers'],
    },
    {
      method: 'post',
      path: '/api/v1/waivers/orgs/{orgId}/{waiverId}/publish',
      summary: 'Publish a reviewed waiver version',
      body: waiverDocumentVersionActionSchema,
      response: waiverDocumentSchema,
      tags: ['waivers'],
    },
    {
      method: 'post',
      path: '/api/v1/waivers/orgs/{orgId}/{waiverId}/retire',
      summary: 'Retire an active published waiver while preserving signatures',
      body: waiverDocumentVersionActionSchema,
      response: waiverDocumentSchema,
      tags: ['waivers'],
    },
    {
      method: 'post',
      path: '/api/v1/waivers/orgs/{orgId}/{waiverId}/signatures',
      summary: 'Capture a verified participant or guardian signature',
      body: waiverSignatureCreateSchema,
      response: waiverSignatureSchema,
      status: 201,
      tags: ['waivers'],
    },
    {
      method: 'get',
      path: '/api/v1/waivers/orgs/{orgId}/signatures',
      summary: 'List waiver signatures for a participant',
      query: { participantPersonId: z.uuid() },
      response: waiverSignatureListSchema,
      tags: ['waivers'],
    },
    {
      method: 'get',
      path: '/api/v1/waivers/orgs/{orgId}/signatures/{signatureId}/pdf',
      summary: 'Download signed waiver evidence PDF',
      response: z.void(),
      binary: true,
      tags: ['waivers'],
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
