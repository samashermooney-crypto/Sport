import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { scheduleJobHandlers } from './generator';
import { createSchedulingRouter } from './routes';
import {
  allocationCreateSchema,
  blackoutDecisionSchema,
  blackoutRequestSchema,
  bulkShiftSchema,
  closureCreateSchema,
  csvImportSchema,
  eventCreateWithOverrideSchema,
  eventListSchema,
  eventResponseSchema,
  eventSeriesCreateSchema,
  eventUpdateSchema,
  calendarFeedListSchema,
  feedCreatedSchema,
  generatorConstraintsSchema,
  generationRunResponseSchema,
  rescheduleRequestSchema,
  scheduleSettingsSchema,
  seriesEditSchema,
  spaceAvailabilityCreateSchema,
  spaceBlackoutCreateSchema,
} from './schema';
import { runScheduleImport, scheduleImportJob } from './tools';

const importJob = { name: scheduleImportJob, run: runScheduleImport };
const jobs: NonNullable<ServerModule['jobs']> = [
  ...scheduleJobHandlers,
  importJob,
];
const base = '/api/v1/scheduling';
const json = z.json();
const eventId = z.strictObject({ id: z.uuid() });
const version = z.strictObject({
  expectedVersion: z.number().int().positive(),
});
const queryDate = z.iso.datetime({ offset: true });
const facilityBody = z.strictObject({
  name: z.string().trim().min(1).max(160),
  address: z.record(z.string(), z.json()).nullable(),
  timezone: z.string().min(1).max(80).nullable(),
  ownership: z.enum(['owned', 'permitted', 'partner']),
  parkingNotes: z.string().max(2000).nullable().optional(),
  mapUrl: z.url().max(2000).nullable().optional(),
  isPublic: z.boolean().optional(),
  layoutImageFileId: z.uuid().nullable().optional(),
});
const spaceBody = z.strictObject({
  facilityId: z.uuid(),
  parentSpaceId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(80),
  surface: z.string().trim().max(80).nullable().optional(),
  hasLights: z.boolean().optional(),
  suitability: z.record(z.string(), z.json()).optional(),
  capacityPeople: z.number().int().positive().nullable().optional(),
});
const route = (
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  summary: string,
  options: {
    body?: z.ZodType;
    response?: z.ZodType;
    query?: Record<string, z.ZodType>;
    public?: boolean;
    binary?: boolean;
    status?: number;
  } = {},
) => ({
  method,
  path: `${base}${path}`,
  summary,
  response: options.response ?? json,
  ...(options.body ? { body: options.body } : {}),
  ...(options.query ? { query: options.query } : {}),
  ...(options.public ? { public: true } : {}),
  ...(options.binary ? { binary: true } : {}),
  ...(options.status ? { status: options.status } : {}),
});

const openapiRoutes = [
  route('get', '/orgs/{orgId}/events', 'List organization events', {
    response: eventListSchema,
    query: {
      from: queryDate,
      to: queryDate,
      programId: z.uuid().optional(),
      teamSeasonId: z.uuid().optional(),
      includeDrafts: z.enum(['true', 'false']).optional(),
    },
  }),
  route('post', '/orgs/{orgId}/events/conflicts', 'Check event conflicts', {
    body: eventCreateWithOverrideSchema,
    response: z.object({ conflicts: z.array(json) }),
  }),
  route('post', '/orgs/{orgId}/events', 'Create an event', {
    body: eventCreateWithOverrideSchema,
    response: eventResponseSchema,
    status: 201,
  }),
  route('get', '/orgs/{orgId}/events/{eventId}', 'Get an event', {
    response: eventResponseSchema,
  }),
  route('patch', '/orgs/{orgId}/events/{eventId}', 'Update an event', {
    body: eventUpdateSchema,
    response: eventResponseSchema,
  }),
  route('post', '/orgs/{orgId}/events/{eventId}/publish', 'Publish an event', {
    body: version,
    response: eventResponseSchema,
  }),
  route(
    'post',
    '/orgs/{orgId}/event-series',
    'Create a recurring event series',
    {
      body: eventSeriesCreateSchema,
      response: z.object({ seriesId: z.uuid(), eventIds: z.array(z.uuid()) }),
      status: 201,
    },
  ),
  route(
    'patch',
    '/orgs/{orgId}/event-series/{seriesId}',
    'Edit a recurring event series',
    {
      body: seriesEditSchema,
      response: z.object({
        seriesId: z.uuid().nullable(),
        eventIds: z.array(z.uuid()),
      }),
    },
  ),
  route('get', '/orgs/{orgId}/facilities', 'List facilities', {
    response: z.object({
      items: z.array(json),
      organizationTimezone: z.string().min(1),
    }),
  }),
  route('post', '/orgs/{orgId}/facilities', 'Create a facility', {
    body: facilityBody,
    response: json,
    status: 201,
  }),
  route('post', '/orgs/{orgId}/spaces', 'Create a facility space', {
    body: spaceBody,
    response: json,
    status: 201,
  }),
  route('get', '/orgs/{orgId}/spaces', 'List facility spaces', {
    response: z.object({ items: z.array(json) }),
    query: { facilityId: z.uuid().optional() },
  }),
  route(
    'get',
    '/orgs/{orgId}/spaces/{spaceId}/availability',
    'List space availability',
    {
      response: z.object({ items: z.array(json) }),
      query: { from: queryDate, to: queryDate },
    },
  ),
  route(
    'post',
    '/orgs/{orgId}/space-availability',
    'Create space availability',
    { body: spaceAvailabilityCreateSchema, response: json, status: 201 },
  ),
  route(
    'post',
    '/orgs/{orgId}/space-blackouts',
    'Create a facility or space blackout',
    { body: spaceBlackoutCreateSchema, response: json, status: 201 },
  ),
  route('put', '/orgs/{orgId}/schedule-settings', 'Update schedule settings', {
    body: scheduleSettingsSchema,
    response: json,
  }),
  route(
    'post',
    '/orgs/{orgId}/team-seasons/{teamSeasonId}/blackout-requests',
    'Request a team schedule blackout',
    { body: blackoutRequestSchema, response: json, status: 201 },
  ),
  route(
    'post',
    '/orgs/{orgId}/blackout-requests/{requestId}/decision',
    'Approve or decline a team blackout request',
    { body: blackoutDecisionSchema, response: json },
  ),
  route(
    'post',
    '/orgs/{orgId}/games/bulk-shift',
    'Move games from one date to another',
    {
      body: bulkShiftSchema,
      response: z.object({
        moved: z.number().int(),
        eventIds: z.array(z.uuid()),
      }),
    },
  ),
  route(
    'post',
    '/orgs/{orgId}/events/{eventId}/swap-home-away',
    'Swap event home and away teams',
    { body: version, response: eventResponseSchema },
  ),
  route('get', '/orgs/{orgId}/schedule.csv', 'Export a schedule as CSV', {
    binary: true,
    query: {
      from: queryDate.optional(),
      to: queryDate.optional(),
      scope: z.enum(['program', 'division', 'team']),
      id: z.uuid(),
    },
  }),
  route(
    'post',
    '/orgs/{orgId}/schedule.csv/import',
    'Upload a schedule file for validation',
    {
      body: csvImportSchema,
      response: z.object({ runId: z.uuid(), status: z.string() }),
      status: 202,
    },
  ),
  route(
    'get',
    '/orgs/{orgId}/schedule-import-runs/{runId}',
    'Get schedule import progress',
    { response: json },
  ),
  route(
    'get',
    '/orgs/{orgId}/schedule-import-runs/{runId}/events',
    'Stream schedule import progress',
    { response: json },
  ),
  route(
    'post',
    '/orgs/{orgId}/schedule-import-runs/{runId}/commit',
    'Commit a validated schedule import',
    { body: version, response: z.object({ eventIds: z.array(z.uuid()) }) },
  ),
  route(
    'post',
    '/orgs/{orgId}/schedule-import-runs/{runId}/discard',
    'Discard a schedule import',
    { body: version, response: z.object({ status: z.string() }) },
  ),
  route(
    'get',
    '/orgs/{orgId}/team-seasons/{teamSeasonId}/practice-allocations',
    'List practice allocations for a team slot picker',
    { response: z.object({ items: z.array(json) }) },
  ),
  route(
    'post',
    '/orgs/{orgId}/allocations',
    'Allocate recurring facility time',
    { body: allocationCreateSchema, response: json, status: 201 },
  ),
  route(
    'post',
    '/orgs/{orgId}/allocations/{allocationId}/requests',
    'Request an allocated practice slot',
    {
      body: z.strictObject({ startsAt: queryDate, endsAt: queryDate }),
      response: json,
      status: 201,
    },
  ),
  route(
    'post',
    '/orgs/{orgId}/allocation-requests/{requestId}/decision',
    'Approve or decline an allocation request',
    {
      body: z.strictObject({
        approve: z.boolean(),
        expectedVersion: z.number().int().positive(),
      }),
      response: json,
    },
  ),
  route(
    'get',
    '/orgs/{orgId}/allocation-requests',
    'List pending allocated-slot requests',
    { response: z.object({ items: z.array(json) }) },
  ),
  route(
    'post',
    '/orgs/{orgId}/closures/preview',
    'Preview schedule closure effects',
    { body: closureCreateSchema, response: json },
  ),
  route(
    'post',
    '/orgs/{orgId}/closures',
    'Close a facility, space, or organization schedule',
    { body: closureCreateSchema, response: json, status: 201 },
  ),
  route(
    'post',
    '/orgs/{orgId}/events/{eventId}/reschedule-requests',
    'Request an event reschedule',
    { body: rescheduleRequestSchema, response: json, status: 201 },
  ),
  route(
    'post',
    '/orgs/{orgId}/reschedule-requests/{requestId}/decision',
    'Approve or decline a reschedule request',
    {
      body: z.strictObject({
        approve: z.boolean(),
        slotIndex: z.number().int().min(0).max(9).optional(),
        expectedVersion: z.number().int().positive(),
      }),
      response: json,
    },
  ),
  route(
    'get',
    '/orgs/{orgId}/reschedule-requests',
    'List open event reschedule requests',
    { response: z.object({ items: z.array(json) }) },
  ),
  route(
    'post',
    '/orgs/{orgId}/programs/{programId}/generation-runs',
    'Start schedule generation',
    { body: generatorConstraintsSchema, response: eventId, status: 202 },
  ),
  route(
    'get',
    '/orgs/{orgId}/generation-runs/{runId}',
    'Get schedule generation progress and explanation report',
    { response: generationRunResponseSchema },
  ),
  route(
    'get',
    '/orgs/{orgId}/generation-runs/{runId}/events',
    'Stream schedule generation progress',
    { response: json },
  ),
  route(
    'post',
    '/orgs/{orgId}/generation-runs/{runId}/apply',
    'Apply a generated schedule atomically',
    { body: version, response: z.object({ eventIds: z.array(z.uuid()) }) },
  ),
  route(
    'post',
    '/orgs/{orgId}/generation-runs/{runId}/discard',
    'Discard a generated schedule',
    { body: version, response: z.object({ status: z.string() }) },
  ),
  route(
    'post',
    '/orgs/{orgId}/calendar-feeds',
    'Create a tokenized calendar feed',
    {
      body: z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('account') }),
        z.strictObject({ type: z.literal('team'), id: z.uuid() }),
        z.strictObject({ type: z.literal('facility'), id: z.uuid() }),
      ]),
      response: feedCreatedSchema,
      status: 201,
    },
  ),
  route(
    'get',
    '/orgs/{orgId}/calendar-feeds',
    'List active tokenized calendar feeds for an account, team, or facility',
    {
      query: {
        type: z.enum(['account', 'team', 'facility']),
        id: z.uuid().optional(),
      },
      response: calendarFeedListSchema,
    },
  ),
  route(
    'delete',
    '/orgs/{orgId}/calendar-feeds/{feedId}',
    'Revoke a tokenized calendar feed',
    { response: z.null(), status: 204 },
  ),
  route(
    'get',
    '/orgs/{orgId}/feeds/{token}.ics',
    'Read a tokenized iCalendar feed',
    { response: z.string(), public: true },
  ),
  route(
    'get',
    '/public/orgs/{slug}/facilities/{facilityId}',
    'View a public facility page and closure banner',
    { response: json, public: true },
  ),
].map((entry) => ({ ...entry, tags: ['scheduling'] }));

export const moduleDefinition = {
  name: 'scheduling',
  path: '/api/v1/scheduling',
  router: createSchedulingRouter,
  jobs,
  permissions: [
    'schedule.read',
    'schedule.manage',
    'results.read',
    'results.manage',
    'attendance.read',
    'attendance.manage',
    'attendance.rsvp',
    'officials.manage',
    'officials.self',
    'tournaments.manage',
  ],
  notificationTypes: ['schedule.changed', 'safety.emergency'],
  errorCodes: ['SCHEDULE_INVALID', 'SCHEDULE_CONFLICT'],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
