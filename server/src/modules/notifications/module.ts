import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { notificationTypes } from './catalog';
import { createNotificationsRouter } from './routes';
import {
  inboxPageSchema,
  markReadSchema,
  preferencesSchema,
  preferenceSchema,
  updatePreferenceSchema,
} from './schema';
import { createStreamRouter } from './stream-routes';

export const moduleDefinition = {
  name: 'notifications',
  path: '/api/v1/notifications',
  router: createNotificationsRouter,
  streamRouter: createStreamRouter,
  jobs: [],
  permissions: [],
  notificationTypes,
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/notifications/orgs/{orgId}/inbox',
      summary: 'List in-app notifications',
      response: inboxPageSchema,
      query: {
        limit: z.string().optional(),
        cursor: z.string().optional(),
        unreadOnly: z.enum(['true', 'false']).optional(),
      },
    },
    {
      method: 'patch',
      path: '/api/v1/notifications/orgs/{orgId}/inbox/{id}/read',
      summary: 'Mark an in-app notification read',
      response: markReadSchema,
    },
    {
      method: 'get',
      path: '/api/v1/notifications/orgs/{orgId}/preferences',
      summary: 'List communication preferences',
      response: preferencesSchema,
    },
    {
      method: 'put',
      path: '/api/v1/notifications/orgs/{orgId}/preferences/{category}/{channel}',
      summary: 'Update a communication preference',
      body: updatePreferenceSchema,
      response: preferenceSchema,
    },
    {
      method: 'get',
      path: '/api/v1/stream',
      summary: 'Stream account notifications',
      response: z.string(),
      contentType: 'text/event-stream',
    },
  ],
} satisfies ServerModule & {
  openapiRoutes: readonly unknown[];
  streamRouter: typeof createStreamRouter;
};
