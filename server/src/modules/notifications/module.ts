import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import {
  createMeNotificationRouter,
  createOrgNotificationRouter,
} from './aliases';
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
  extraRouters: [
    { path: '/api/v1/stream', router: createStreamRouter },
    { path: '/api/v1/orgs', router: createOrgNotificationRouter },
    { path: '/api/v1/me', router: createMeNotificationRouter },
  ],
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
    {
      method: 'get',
      path: '/api/v1/orgs/{orgId}/notifications',
      summary: 'List organization notifications for the account',
      response: inboxPageSchema,
      query: {
        limit: z.string().optional(),
        cursor: z.string().optional(),
        unreadOnly: z.enum(['true', 'false']).optional(),
      },
    },
    {
      method: 'patch',
      path: '/api/v1/orgs/{orgId}/notifications/{id}/read',
      summary: 'Mark an organization notification read',
      response: markReadSchema,
    },
    {
      method: 'get',
      path: '/api/v1/orgs/{orgId}/notification-preferences',
      summary: 'List organization notification preferences',
      response: preferencesSchema,
    },
    {
      method: 'put',
      path: '/api/v1/orgs/{orgId}/notification-preferences/{category}/{channel}',
      summary: 'Update an organization notification preference',
      body: updatePreferenceSchema,
      response: preferenceSchema,
    },
    {
      method: 'get',
      path: '/api/v1/me/notifications',
      summary: 'List account notifications for one organization',
      response: inboxPageSchema,
      query: {
        orgId: z.uuid(),
        limit: z.string().optional(),
        cursor: z.string().optional(),
        unreadOnly: z.enum(['true', 'false']).optional(),
      },
    },
    {
      method: 'patch',
      path: '/api/v1/me/notifications/{id}/read',
      summary: 'Mark an account notification read',
      response: markReadSchema,
      query: { orgId: z.uuid() },
    },
    {
      method: 'get',
      path: '/api/v1/me/notification-preferences',
      summary: 'List account preferences for one organization',
      response: preferencesSchema,
      query: { orgId: z.uuid() },
    },
    {
      method: 'put',
      path: '/api/v1/me/notification-preferences/{category}/{channel}',
      summary: 'Update an account preference for one organization',
      body: updatePreferenceSchema,
      response: preferenceSchema,
      query: { orgId: z.uuid() },
    },
  ],
} satisfies ServerModule & {
  openapiRoutes: readonly unknown[];
};
