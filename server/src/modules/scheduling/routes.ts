import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { withOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { assertSchedulePermission } from './access';
import {
  createCalendarFeed,
  createEvent,
  createEventSeries,
  createFacility,
  createSpace,
  editEventSeries,
  getCalendarFeed,
  getConflicts,
  getEvent,
  listEvents,
  listCalendarFeeds,
  listFacilities,
  listSpaces,
  publicFacilityPage,
  publishEvent,
  revokeCalendarFeed,
  updateEvent,
  SchedulingRuleError,
} from './events';
import {
  applyGenerationRun,
  createGenerationRun,
  discardGenerationRun,
  getGenerationRun,
} from './generator';
import { mutationOriginIsValid, sendScheduleError } from './http';
import {
  createAllocation,
  createClosure,
  decideAllocationRequest,
  decideRescheduleRequest,
  listTeamPracticeAllocations,
  listAllocationRequests,
  listRescheduleRequests,
  previewClosure,
  requestAllocationSlot,
  requestReschedule,
} from './operations';
import {
  allocationCreateSchema,
  blackoutDecisionSchema,
  blackoutRequestSchema,
  bulkShiftSchema,
  closureCreateSchema,
  csvImportSchema,
  eventCreateWithOverrideSchema,
  eventUpdateSchema,
  generatorConstraintsSchema,
  rescheduleRequestSchema,
  scheduleSettingsSchema,
  spaceAvailabilityCreateSchema,
  spaceBlackoutCreateSchema,
  seriesEditSchema,
  eventSeriesCreateSchema,
} from './schema';
import {
  createSpaceAvailability,
  createSpaceBlackout,
  createTeamBlackoutRequest,
  decideTeamBlackoutRequest,
  exportScheduleCsv,
  createScheduleImport,
  getScheduleImport,
  commitScheduleImport,
  discardScheduleImport,
  listSpaceAvailability,
  shiftGamesOnDate,
  swapHomeAway,
  updateScheduleSettings,
} from './tools';

const idSchema = z.uuid();
const expectedVersionSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});
const calendarFeedCreateSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('account') }),
  z.strictObject({ type: z.literal('team'), id: idSchema }),
  z.strictObject({ type: z.literal('facility'), id: idSchema }),
]);
const calendarFeedListQuerySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('account') }),
  z.strictObject({ type: z.literal('team'), id: idSchema }),
  z.strictObject({ type: z.literal('facility'), id: idSchema }),
]);
const closureParamsSchema = z.strictObject({
  scopeType: z.enum(['facility', 'space', 'org']),
  scopeId: z.uuid().nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: z.enum(['weather', 'maintenance', 'permit', 'other']),
  message: z.string().trim().max(500).nullable().optional(),
});
const facilityCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  address: z.record(z.string(), z.json()).nullable(),
  timezone: z.string().min(1).max(80).nullable(),
  ownership: z.enum(['owned', 'permitted', 'partner']),
  parkingNotes: z.string().max(2000).nullable().optional(),
  mapUrl: z
    .url()
    .max(2000)
    .refine(
      (value) => ['https:', 'http:'].includes(new URL(value).protocol),
      'Map link must use HTTP or HTTPS',
    )
    .nullable()
    .optional(),
  isPublic: z.boolean().optional(),
  layoutImageFileId: z.uuid().nullable().optional(),
});
const spaceCreateSchema = z.strictObject({
  facilityId: z.uuid(),
  parentSpaceId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(80),
  surface: z.string().trim().max(80).nullable().optional(),
  hasLights: z.boolean().optional(),
  suitability: z.record(z.string(), z.json()).optional(),
  capacityPeople: z.number().int().positive().nullable().optional(),
});
const allocationRequestSchema = z.strictObject({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
});
const requestDecisionSchema = z.strictObject({
  approve: z.boolean(),
  expectedVersion: z.number().int().positive(),
});
const rescheduleDecisionSchema = z.strictObject({
  approve: z.boolean(),
  slotIndex: z.number().int().min(0).max(9).optional(),
  expectedVersion: z.number().int().positive(),
});

async function authenticatedContext(
  dependencies: AuthDependencies,
  request: Request,
): Promise<OrgContext> {
  const session = await requireSession(dependencies, request);
  return {
    orgId: idSchema.parse(request.params.orgId),
    actor: { accountId: session.accountId },
  };
}

function requireVerifiedMutation(
  dependencies: AuthDependencies,
  request: Request,
): void {
  if (!mutationOriginIsValid(request, dependencies.appUrl))
    throw new SchedulingRuleError(
      'Request origin could not be verified.',
      403,
      'FORBIDDEN',
    );
}

function handleError(response: Response, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  sendScheduleError(response, error);
}

export function createSchedulingRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '28mb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/orgs/:orgId/events', async (request, response) => {
    try {
      const context = await authenticatedContext(dependencies, request);
      const query = request.query as Record<string, unknown>;
      const from = new Date(z.iso.datetime({ offset: true }).parse(query.from));
      const to = new Date(z.iso.datetime({ offset: true }).parse(query.to));
      const programId =
        query.programId === undefined
          ? undefined
          : idSchema.parse(query.programId);
      const teamSeasonId =
        query.teamSeasonId === undefined
          ? undefined
          : idSchema.parse(query.teamSeasonId);
      const includeDrafts = query.includeDrafts === 'true';
      response.json({
        items: await listEvents(context, {
          from,
          to,
          ...(programId ? { programId } : {}),
          ...(teamSeasonId ? { teamSeasonId } : {}),
          includeDrafts,
        }),
      });
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post('/orgs/:orgId/events/conflicts', async (request, response) => {
    try {
      const context = await authenticatedContext(dependencies, request);
      const input = eventCreateWithOverrideSchema.parse(request.body);
      const report = await withOrg(context, async (trx) => {
        await assertSchedulePermission(trx, context, 'schedule.manage', {
          ...(input.programId ? { programId: input.programId } : {}),
          ...(input.divisionId ? { divisionId: input.divisionId } : {}),
        });
        const conflicts = await getConflicts(trx, context, input);
        return { conflicts };
      });
      response.json(report);
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post('/orgs/:orgId/events', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const context = await authenticatedContext(dependencies, request);
      response
        .status(201)
        .json(
          await createEvent(
            context,
            eventCreateWithOverrideSchema.parse(request.body),
          ),
        );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.get('/orgs/:orgId/events/:eventId', async (request, response) => {
    try {
      const context = await authenticatedContext(dependencies, request);
      response.json(
        await getEvent(context, idSchema.parse(request.params.eventId)),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.patch('/orgs/:orgId/events/:eventId', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const context = await authenticatedContext(dependencies, request);
      response.json(
        await updateEvent(
          context,
          idSchema.parse(request.params.eventId),
          eventUpdateSchema.parse(request.body),
        ),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/events/:eventId/publish',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const context = await authenticatedContext(dependencies, request);
        const input = expectedVersionSchema.parse(request.body);
        response.json(
          await publishEvent(
            context,
            idSchema.parse(request.params.eventId),
            input.expectedVersion,
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post('/orgs/:orgId/event-series', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const context = await authenticatedContext(dependencies, request);
      response
        .status(201)
        .json(
          await createEventSeries(
            context,
            eventSeriesCreateSchema.parse(request.body),
          ),
        );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.patch(
    '/orgs/:orgId/event-series/:seriesId',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const context = await authenticatedContext(dependencies, request);
        response.json(
          await editEventSeries(
            context,
            idSchema.parse(request.params.seriesId),
            seriesEditSchema.parse(request.body),
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/facilities', async (request, response) => {
    try {
      response.json(
        await listFacilities(await authenticatedContext(dependencies, request)),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post('/orgs/:orgId/facilities', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const context = await authenticatedContext(dependencies, request);
      const input = facilityCreateSchema.parse(request.body);
      response.status(201).json(
        await createFacility(context, {
          name: input.name,
          address: input.address,
          timezone: input.timezone,
          ownership: input.ownership,
          ...(input.parkingNotes === undefined
            ? {}
            : { parkingNotes: input.parkingNotes }),
          ...(input.mapUrl === undefined ? {} : { mapUrl: input.mapUrl }),
          ...(input.isPublic === undefined ? {} : { isPublic: input.isPublic }),
          ...(input.layoutImageFileId === undefined
            ? {}
            : { layoutImageFileId: input.layoutImageFileId }),
        }),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post('/orgs/:orgId/spaces', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const context = await authenticatedContext(dependencies, request);
      const input = spaceCreateSchema.parse(request.body);
      response.status(201).json(
        await createSpace(context, {
          facilityId: input.facilityId,
          name: input.name,
          kind: input.kind,
          ...(input.parentSpaceId === undefined
            ? {}
            : { parentSpaceId: input.parentSpaceId }),
          ...(input.surface === undefined ? {} : { surface: input.surface }),
          ...(input.hasLights === undefined
            ? {}
            : { hasLights: input.hasLights }),
          ...(input.suitability === undefined
            ? {}
            : { suitability: input.suitability }),
          ...(input.capacityPeople === undefined
            ? {}
            : { capacityPeople: input.capacityPeople }),
        }),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.get('/orgs/:orgId/spaces', async (request, response) => {
    try {
      const context = await authenticatedContext(dependencies, request);
      const facilityId =
        request.query.facilityId === undefined
          ? undefined
          : idSchema.parse(request.query.facilityId);
      response.json({ items: await listSpaces(context, facilityId) });
    } catch (error) {
      handleError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/spaces/:spaceId/availability',
    async (request, response) => {
      try {
        response.json({
          items: await listSpaceAvailability(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.spaceId),
          ),
        });
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post('/orgs/:orgId/space-availability', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const context = await authenticatedContext(dependencies, request);
      const input = spaceAvailabilityCreateSchema.parse(request.body);
      response.status(201).json(
        await createSpaceAvailability(context, {
          spaceId: input.spaceId,
          recurrence: input.recurrence,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          startTime: input.startTime,
          endTime: input.endTime,
          timezone: input.timezone,
          source: input.source,
          ...(input.permitReference === undefined
            ? {}
            : { permitReference: input.permitReference }),
          ...(input.costPerHourCents === undefined
            ? {}
            : { costPerHourCents: input.costPerHourCents }),
        }),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post('/orgs/:orgId/space-blackouts', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const context = await authenticatedContext(dependencies, request);
      response
        .status(201)
        .json(
          await createSpaceBlackout(
            context,
            spaceBlackoutCreateSchema.parse(request.body),
          ),
        );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.put('/orgs/:orgId/schedule-settings', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const input = scheduleSettingsSchema.parse(request.body);
      response.json(
        await updateScheduleSettings(
          await authenticatedContext(dependencies, request),
          {
            programId: input.programId,
            coachSlotPickerEnabled: input.coachSlotPickerEnabled,
            slotApprovalRequired: input.slotApprovalRequired,
            ...(input.expectedVersion === undefined
              ? {}
              : { expectedVersion: input.expectedVersion }),
          },
        ),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/team-seasons/:teamSeasonId/blackout-requests',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        response
          .status(201)
          .json(
            await createTeamBlackoutRequest(
              await authenticatedContext(dependencies, request),
              idSchema.parse(request.params.teamSeasonId),
              blackoutRequestSchema.parse(request.body),
            ),
          );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/blackout-requests/:requestId/decision',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        response.json(
          await decideTeamBlackoutRequest(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.requestId),
            blackoutDecisionSchema.parse(request.body),
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post('/orgs/:orgId/games/bulk-shift', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const input = bulkShiftSchema.parse(request.body);
      response.json(
        await shiftGamesOnDate(
          await authenticatedContext(dependencies, request),
          {
            fromDate: input.fromDate,
            toDate: input.toDate,
            timezone: input.timezone,
            ...(input.overrideReason
              ? { overrideReason: input.overrideReason }
              : {}),
          },
        ),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/events/:eventId/swap-home-away',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const input = expectedVersionSchema.parse(request.body);
        await swapHomeAway(
          await authenticatedContext(dependencies, request),
          idSchema.parse(request.params.eventId),
          input.expectedVersion,
        );
        response.status(204).end();
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/schedule.csv', async (request, response) => {
    try {
      const context = await authenticatedContext(dependencies, request);
      const query = request.query as Record<string, unknown>;
      const scope = z
        .strictObject({
          type: z.enum(['program', 'division', 'team']),
          id: z.uuid(),
        })
        .parse({ type: query.scope, id: query.id });
      const from = new Date(z.iso.datetime({ offset: true }).parse(query.from));
      const to = new Date(z.iso.datetime({ offset: true }).parse(query.to));
      response
        .type('text/csv; charset=utf-8')
        .set('Content-Disposition', 'attachment; filename="schedule.csv"')
        .send(await exportScheduleCsv(context, scope, { from, to }));
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post('/orgs/:orgId/schedule.csv/import', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const input = csvImportSchema.parse(request.body);
      const context = await authenticatedContext(dependencies, request);
      const fileName = 'csv' in input ? 'schedule-import.csv' : input.fileName;
      const bytes =
        'csv' in input
          ? Buffer.from(input.csv, 'utf8')
          : Buffer.from(input.contentBase64, 'base64');
      if (
        'contentBase64' in input &&
        (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64) ||
          bytes.toString('base64').replace(/=+$/, '') !==
            input.contentBase64.replace(/=+$/, ''))
      )
        throw new SchedulingRuleError('The uploaded file encoding is invalid.');
      const id = await createScheduleImport(context, bytes, fileName);
      response.status(202).json({ id, status: 'queued' });
    } catch (error) {
      handleError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/schedule-import-runs/:runId',
    async (request, response) => {
      try {
        response.json(
          await getScheduleImport(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.runId),
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/schedule-import-runs/:runId/events',
    async (request, response) => {
      try {
        const context = await authenticatedContext(dependencies, request);
        response.status(200).set({
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        const signal = new AbortController();
        response.on('close', () => {
          signal.abort();
        });
        let previous = '';
        const deadline = Date.now() + 10 * 60_000;
        while (!signal.signal.aborted && Date.now() < deadline) {
          const run = await getScheduleImport(
            context,
            idSchema.parse(request.params.runId),
          );
          const event = JSON.stringify({
            id: run.id,
            status: run.status,
            progress: run.progress,
            version: run.version,
          });
          if (event !== previous)
            response.write(`event: progress\ndata: ${event}\n\n`);
          previous = event;
          if (
            ['ready', 'invalid', 'committed', 'discarded', 'failed'].includes(
              run.status,
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        response.end();
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/schedule-import-runs/:runId/commit',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const input = expectedVersionSchema.parse(request.body);
        const result = await commitScheduleImport(
          await authenticatedContext(dependencies, request),
          idSchema.parse(request.params.runId),
          input.expectedVersion,
        );
        response.status(result.committed ? 201 : 422).json(result);
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/schedule-import-runs/:runId/discard',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const input = expectedVersionSchema.parse(request.body);
        await discardScheduleImport(
          await authenticatedContext(dependencies, request),
          idSchema.parse(request.params.runId),
          input.expectedVersion,
        );
        response.status(204).end();
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post('/orgs/:orgId/allocations', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const input = allocationCreateSchema.parse(request.body);
      response.status(201).json(
        await createAllocation(
          await authenticatedContext(dependencies, request),
          {
            spaceId: input.spaceId,
            recurrence: input.recurrence,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            startTime: input.startTime,
            endTime: input.endTime,
            timezone: input.timezone,
            purpose: input.purpose,
            ...(input.teamSeasonId === undefined
              ? {}
              : { teamSeasonId: input.teamSeasonId }),
            ...(input.divisionId === undefined
              ? {}
              : { divisionId: input.divisionId }),
          },
        ),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/team-seasons/:teamSeasonId/practice-allocations',
    async (request, response) => {
      try {
        response.json({
          items: await listTeamPracticeAllocations(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.teamSeasonId),
          ),
        });
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/allocations/:allocationId/requests',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        response
          .status(201)
          .json(
            await requestAllocationSlot(
              await authenticatedContext(dependencies, request),
              idSchema.parse(request.params.allocationId),
              allocationRequestSchema.parse(request.body),
            ),
          );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/allocation-requests/:requestId/decision',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        response.json(
          await decideAllocationRequest(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.requestId),
            requestDecisionSchema.parse(request.body),
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/allocation-requests', async (request, response) => {
    try {
      response.json({
        items: await listAllocationRequests(
          await authenticatedContext(dependencies, request),
        ),
      });
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post('/orgs/:orgId/closures/preview', async (request, response) => {
    try {
      const context = await authenticatedContext(dependencies, request);
      const input = closureParamsSchema.parse(request.body);
      response.json(
        await previewClosure(context, {
          ...input,
          scopeId: input.scopeId ?? null,
          message: input.message ?? null,
          previewOnly: true,
        }),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post('/orgs/:orgId/closures', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const context = await authenticatedContext(dependencies, request);
      const input = closureCreateSchema.parse(request.body);
      response.status(201).json(
        await createClosure(context, {
          ...input,
          scopeId: input.scopeId ?? null,
          message: input.message ?? null,
        }),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/events/:eventId/reschedule-requests',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const input = rescheduleRequestSchema.parse(request.body);
        response.status(201).json(
          await requestReschedule(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.eventId),
            {
              reason: input.reason,
              proposedSlots: input.proposedSlots.map((slot) => ({
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                ...(slot.spaceId === undefined
                  ? {}
                  : { spaceId: slot.spaceId }),
              })),
            },
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/reschedule-requests/:requestId/decision',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const input = rescheduleDecisionSchema.parse(request.body);
        response.json(
          await decideRescheduleRequest(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.requestId),
            {
              approve: input.approve,
              expectedVersion: input.expectedVersion,
              ...(input.slotIndex === undefined
                ? {}
                : { slotIndex: input.slotIndex }),
            },
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/reschedule-requests', async (request, response) => {
    try {
      response.json({
        items: await listRescheduleRequests(
          await authenticatedContext(dependencies, request),
        ),
      });
    } catch (error) {
      handleError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/programs/:programId/generation-runs',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const context = await authenticatedContext(dependencies, request);
        const runId = await createGenerationRun(
          context,
          idSchema.parse(request.params.programId),
          generatorConstraintsSchema.parse(request.body),
        );
        response.status(202).json({ id: runId });
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/generation-runs/:runId',
    async (request, response) => {
      try {
        response.json(
          await getGenerationRun(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.runId),
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/generation-runs/:runId/events',
    async (request, response) => {
      try {
        const context = await authenticatedContext(dependencies, request);
        response.status(200).set({
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        const signal = new AbortController();
        response.on('close', () => {
          signal.abort();
        });
        let previous = '';
        const deadline = Date.now() + 10 * 60_000;
        while (!signal.signal.aborted && Date.now() < deadline) {
          const run = await getGenerationRun(
            context,
            idSchema.parse(request.params.runId),
          );
          const event = JSON.stringify({
            id: run.id,
            status: run.status,
            progress: run.progress,
            progressMessage: run.progress_message,
            version: run.version,
          });
          if (event !== previous)
            response.write(`event: progress\ndata: ${event}\n\n`);
          previous = event;
          if (
            ['succeeded', 'failed', 'applied', 'discarded'].includes(run.status)
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        response.end();
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/generation-runs/:runId/apply',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const input = expectedVersionSchema.parse(request.body);
        response.json(
          await applyGenerationRun(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.runId),
            input.expectedVersion,
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/generation-runs/:runId/discard',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        const input = expectedVersionSchema.parse(request.body);
        response.json(
          await discardGenerationRun(
            await authenticatedContext(dependencies, request),
            idSchema.parse(request.params.runId),
            input.expectedVersion,
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.post('/orgs/:orgId/calendar-feeds', async (request, response) => {
    try {
      requireVerifiedMutation(dependencies, request);
      const input = calendarFeedCreateSchema.parse(request.body);
      response
        .status(201)
        .json(
          await createCalendarFeed(
            await authenticatedContext(dependencies, request),
            input,
          ),
        );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.get('/orgs/:orgId/calendar-feeds', async (request, response) => {
    try {
      const input = calendarFeedListQuerySchema.parse(request.query);
      response.json(
        await listCalendarFeeds(
          await authenticatedContext(dependencies, request),
          input,
        ),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.delete(
    '/orgs/:orgId/calendar-feeds/:feedId',
    async (request, response) => {
      try {
        requireVerifiedMutation(dependencies, request);
        await revokeCalendarFeed(
          await authenticatedContext(dependencies, request),
          idSchema.parse(request.params.feedId),
        );
        response.status(204).end();
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/feeds/:token.ics', async (request, response) => {
    try {
      const token = z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(request.params.token);
      response.type('text/calendar; charset=utf-8').send(
        await getCalendarFeed(
          {
            orgId: idSchema.parse(request.params.orgId),
            actor: { accountId: '00000000-0000-7000-8000-000000000000' },
          },
          token,
        ),
      );
    } catch (error) {
      handleError(response, error);
    }
  });

  router.get(
    '/public/orgs/:slug/facilities/:facilityId',
    async (request, response) => {
      try {
        const slug = z.string().min(1).max(120).parse(request.params.slug);
        response.json(
          await publicFacilityPage(
            slug,
            idSchema.parse(request.params.facilityId),
          ),
        );
      } catch (error) {
        handleError(response, error);
      }
    },
  );

  return router;
}
