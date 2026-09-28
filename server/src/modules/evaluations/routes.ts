import express from 'express';
import { z } from 'zod';

import type { AuthDependencies } from '../auth/routes';
import {
  AccessError,
  mutationOriginIsValid,
  orgActor,
  requireAnyRole,
  sendModuleError,
} from '../compliance/access';

import {
  boardCreateSchema,
  evaluationEvaluatorSchema,
  evaluationCreateSchema,
  evaluationSessionSchema,
  familyPlacementPreferenceSchema,
  offerDeclineSchema,
  offerSchema,
  participantSchema,
  placementMoveSchema,
  placementPreferenceSchema,
  participantCheckInSchema,
  placementLockSchema,
  scoreSchema,
} from './schemas';
import {
  assignEvaluationEvaluator,
  assignEvaluationParticipant,
  acceptTeamOffer,
  checkInEvaluationParticipant,
  computeEvaluationResults,
  createEvaluationEvent,
  createEvaluationSession,
  createPlacementBoard,
  createTeamOffer,
  declineTeamOffer,
  evaluationConsistency,
  EvaluationError,
  getEvaluationSetup,
  getPlacementBoard,
  listEvaluationEvents,
  listEvaluationEvaluatorCandidates,
  listEvaluationResults,
  listEvaluationPrograms,
  listEvaluationRegistrants,
  listFamilyOffers,
  listEvaluationScoringSheet,
  listMyEvaluationResults,
  listMyPlacementPrograms,
  listOfferDashboard,
  listPlacementPreferences,
  lockPlacement,
  movePlacement,
  publishPlacementBoard,
  upsertEvaluationScore,
  upsertPlacementPreference,
  upsertMyPlacementPreference,
  withdrawTeamOffer,
} from './service';
import type { EvaluationDependencies } from './service';
import type { OfferCheckoutAdapter } from './service';

const uuid = (value: unknown) => z.uuid().parse(value);

export type EvaluationsRouterDependencies = AuthDependencies & {
  offerCheckout?: OfferCheckoutAdapter;
};

export function createEvaluationsRouter(
  dependencies: EvaluationsRouterDependencies,
): express.Router {
  const router = express.Router();
  const evaluations: EvaluationDependencies = {
    database: dependencies.database,
    clock: dependencies.clock,
  };
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use((request, response, next) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !mutationOriginIsValid(request, dependencies.appUrl)
    ) {
      response.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Request origin could not be verified',
        },
      });
      return;
    }
    next();
  });
  router.use(express.json({ limit: '64kb' }));
  const endpoint =
    (
      action: (
        request: express.Request,
        response: express.Response,
      ) => Promise<void>,
    ) =>
    async (request: express.Request, response: express.Response) => {
      try {
        await action(request, response);
      } catch (error) {
        if (error instanceof EvaluationError) {
          response
            .status(error.status)
            .json({ error: { code: error.code, message: error.message } });
          return;
        }
        sendModuleError(response, error);
      }
    };
  const director = async (request: express.Request) => {
    const actor = await orgActor(dependencies, request);
    requireAnyRole(actor.roles, [
      'owner',
      'admin',
      'director',
      'registrar',
      'scheduler',
    ]);
    return actor;
  };
  const evaluator = async (request: express.Request) => {
    const actor = await orgActor(dependencies, request);
    requireAnyRole(actor.roles, ['owner', 'admin', 'director', 'evaluator']);
    return actor;
  };

  router.get(
    '/orgs/:orgId/events',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(await listEvaluationEvents(evaluations, actor.context));
    }),
  );
  router.get(
    '/orgs/:orgId/programs',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(await listEvaluationPrograms(evaluations, actor.context));
    }),
  );
  router.get(
    '/orgs/:orgId/evaluator-candidates',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await listEvaluationEvaluatorCandidates(evaluations, actor.context),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/events/:eventId/setup',
    endpoint(async (request, response) => {
      const actor = await director(request);
      const setup = await getEvaluationSetup(
        evaluations,
        actor.context,
        uuid(request.params.eventId),
      );
      response.json({
        ...setup,
        canManagePhotos: actor.roles.some((role) =>
          ['owner', 'admin', 'registrar'].includes(role),
        ),
      });
    }),
  );
  router.get(
    '/orgs/:orgId/events/:eventId/registrants',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await listEvaluationRegistrants(
          evaluations,
          actor.context,
          uuid(request.params.eventId),
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/events',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response
        .status(201)
        .json(
          await createEvaluationEvent(
            evaluations,
            actor.context,
            evaluationCreateSchema.parse(request.body),
          ),
        );
    }),
  );
  router.post(
    '/orgs/:orgId/events/:eventId/sessions',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response
        .status(201)
        .json(
          await createEvaluationSession(
            evaluations,
            actor.context,
            uuid(request.params.eventId),
            evaluationSessionSchema.parse(request.body),
          ),
        );
    }),
  );
  router.post(
    '/orgs/:orgId/events/:eventId/evaluators',
    endpoint(async (request, response) => {
      const actor = await director(request);
      const body = evaluationEvaluatorSchema.parse(request.body);
      response
        .status(201)
        .json(
          await assignEvaluationEvaluator(
            evaluations,
            actor.context,
            body.sessionId,
            body.accountId,
          ),
        );
    }),
  );
  router.post(
    '/orgs/:orgId/events/:eventId/participants',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response
        .status(201)
        .json(
          await assignEvaluationParticipant(
            evaluations,
            actor.context,
            uuid(request.params.eventId),
            participantSchema.parse(request.body),
          ),
        );
    }),
  );
  router.post(
    '/orgs/:orgId/participants/:participantId/check-in',
    endpoint(async (request, response) => {
      const actor = await director(request);
      const body = participantCheckInSchema.parse(request.body);
      response.json(
        await checkInEvaluationParticipant(
          evaluations,
          actor.context,
          uuid(request.params.participantId),
          body.late,
        ),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/events/:eventId/scoring-sheet',
    endpoint(async (request, response) => {
      const actor = await evaluator(request);
      const mayViewAll = actor.roles.some((role) =>
        ['owner', 'admin', 'director'].includes(role),
      );
      response.json(
        await listEvaluationScoringSheet(
          evaluations,
          actor.context,
          uuid(request.params.eventId),
          actor.session.accountId,
          mayViewAll,
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/events/:eventId/scores',
    endpoint(async (request, response) => {
      const actor = await evaluator(request);
      const mayScoreAll = actor.roles.some((role) =>
        ['owner', 'admin', 'director'].includes(role),
      );
      response.json(
        await upsertEvaluationScore(
          evaluations,
          actor.context,
          uuid(request.params.eventId),
          actor.session.accountId,
          scoreSchema.parse(request.body),
          mayScoreAll,
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/events/:eventId/compute-results',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await computeEvaluationResults(
          evaluations,
          actor.context,
          uuid(request.params.eventId),
        ),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/events/:eventId/consistency',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await evaluationConsistency(
          evaluations,
          actor.context,
          uuid(request.params.eventId),
        ),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/events/:eventId/results',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await listEvaluationResults(
          evaluations,
          actor.context,
          uuid(request.params.eventId),
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/events/:eventId/boards',
    endpoint(async (request, response) => {
      const actor = await director(request);
      const body = boardCreateSchema.parse(request.body);
      const event = uuid(request.params.eventId);
      // Event ownership is checked inside the service; the target is read from it below.
      const events = await listEvaluationEvents(evaluations, actor.context);
      const selected = events.find((item) => item.id === event);
      if (!selected)
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Evaluation event not found',
        );
      response
        .status(201)
        .json(
          await createPlacementBoard(
            evaluations,
            actor.context,
            event,
            selected.targetProgramId,
            body,
          ),
        );
    }),
  );
  router.post(
    '/orgs/:orgId/boards/:boardId/placements/move',
    endpoint(async (request, response) => {
      const actor = await director(request);
      const body = placementMoveSchema.parse(request.body);
      response.json(
        await movePlacement(
          evaluations,
          actor.context,
          uuid(request.params.boardId),
          body.personId,
          body.teamSeasonId,
          body.expectedVersion,
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/boards/:boardId/placements/:personId/lock',
    endpoint(async (request, response) => {
      const actor = await director(request);
      const body = placementLockSchema.parse(request.body);
      response.json(
        await lockPlacement(
          evaluations,
          actor.context,
          uuid(request.params.boardId),
          uuid(request.params.personId),
          body.reason,
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/boards/:boardId/publish',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await publishPlacementBoard(
          evaluations,
          actor.context,
          uuid(request.params.boardId),
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/programs/:programId/boards',
    endpoint(async (request, response) => {
      const actor = await director(request);
      const body = boardCreateSchema.parse(request.body);
      response
        .status(201)
        .json(
          await createPlacementBoard(
            evaluations,
            actor.context,
            null,
            uuid(request.params.programId),
            body,
          ),
        );
    }),
  );
  router.get(
    '/orgs/:orgId/programs/:programId/placement-preferences',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await listPlacementPreferences(
          evaluations,
          actor.context,
          uuid(request.params.programId),
        ),
      );
    }),
  );
  router.put(
    '/orgs/:orgId/programs/:programId/placement-preferences',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await upsertPlacementPreference(
          evaluations,
          actor.context,
          uuid(request.params.programId),
          placementPreferenceSchema.parse(request.body),
        ),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/me/placement-programs',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(await listMyPlacementPrograms(evaluations, actor.context));
    }),
  );
  router.put(
    '/orgs/:orgId/me/programs/:programId/placement-preference',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await upsertMyPlacementPreference(
          evaluations,
          actor.context,
          uuid(request.params.programId),
          familyPlacementPreferenceSchema.parse(request.body),
        ),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/boards/:boardId/offers',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await listOfferDashboard(
          evaluations,
          actor.context,
          uuid(request.params.boardId),
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/offers/:offerId/withdraw',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await withdrawTeamOffer(
          evaluations,
          actor.context,
          uuid(request.params.offerId),
        ),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/me/results',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(await listMyEvaluationResults(evaluations, actor.context));
    }),
  );
  router.get(
    '/orgs/:orgId/boards/:boardId',
    endpoint(async (request, response) => {
      const actor = await director(request);
      response.json(
        await getPlacementBoard(
          evaluations,
          actor.context,
          uuid(request.params.boardId),
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/placements/:placementId/offers',
    endpoint(async (request, response) => {
      const actor = await director(request);
      const body = offerSchema.parse(request.body);
      response
        .status(201)
        .json(
          await createTeamOffer(
            evaluations,
            actor.context,
            uuid(request.params.placementId),
            body.offeringId,
            body.amountCents,
            body.depositCents,
            body.expiresAt,
            body.message,
          ),
        );
    }),
  );
  router.post(
    '/orgs/:orgId/offers/:offerId/decline',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = offerDeclineSchema.parse(request.body);
      response.json(
        await declineTeamOffer(
          evaluations,
          actor.context,
          uuid(request.params.offerId),
          body.reason,
          body.expectedVersion,
        ),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/me/offers',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const offers = await listFamilyOffers(evaluations, actor.context);
      const acceptanceReady = Boolean(dependencies.offerCheckout);
      response.json(offers.map((offer) => ({ ...offer, acceptanceReady })));
    }),
  );
  router.post(
    '/orgs/:orgId/offers/:offerId/accept',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const checkout = dependencies.offerCheckout;
      if (!checkout)
        throw new EvaluationError(
          503,
          'CHECKOUT_UNAVAILABLE',
          'Offer checkout is not wired to the registration checkout service yet',
        );
      response.json(
        await acceptTeamOffer(
          evaluations,
          actor.context,
          uuid(request.params.offerId),
          checkout,
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/events/:eventId/export.csv',
    endpoint(async (request, response) => {
      const actor = await director(request);
      if (
        !actor.session.elevatedUntil ||
        actor.session.elevatedUntil <= dependencies.clock()
      )
        throw new AccessError(
          403,
          'STEP_UP_REQUIRED',
          'Step-up authentication is required for evaluation exports',
        );
      const values = await computeEvaluationResults(
        evaluations,
        actor.context,
        uuid(request.params.eventId),
      );
      response
        .type('text/csv; charset=utf-8')
        .attachment(`evaluation-${String(request.params.eventId)}.csv`);
      const quote = (value: string | number | null) =>
        `"${String(value ?? '').replaceAll('"', '""')}"`;
      response.send(
        [
          'participant_id,group,composite,rank,evaluator_count,missing_criteria',
          ...values.map((row) =>
            [
              row.participantId,
              row.group,
              row.composite,
              row.rankInGroup,
              row.evaluatorCount,
              row.missingCriteria.join(';'),
            ]
              .map(quote)
              .join(','),
          ),
        ].join('\r\n'),
      );
    }),
  );

  return router;
}
