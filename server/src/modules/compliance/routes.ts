import { createHmac, timingSafeEqual } from 'node:crypto';

import express from 'express';
import { sql } from 'kysely';
import { z } from 'zod';

import {
  CheckrBackgroundCheckProvider,
  ManualBackgroundCheckProvider,
} from '../../integrations/background-check/provider';
import type { AuthDependencies } from '../auth/routes';

import {
  AccessError,
  isComplianceOfficer,
  mutationOriginIsValid,
  orgActor,
  requireAnyRole,
  sendModuleError,
} from './access';
import {
  createCard,
  listCards,
  revokeCard,
  verifyCard,
  readCardPhoto,
  CardError,
} from './cards';
import {
  backgroundAdjudicationSchema,
  backgroundConsentSchema,
  backgroundResultSchema,
  backgroundSettingsSchema,
  cardBodySchema,
  cardStatusSchema,
  complianceOverrideSchema,
  credentialBodySchema,
  credentialRevokeSchema,
  credentialRequirementSchema,
  credentialReviewSchema,
  credentialSubmissionUpdateSchema,
  credentialTypeUpdateSchema,
  requirementUpdateSchema,
} from './schemas';
import {
  adjudicateBackgroundCheck,
  beginBackgroundCheck,
  createComplianceOverride,
  dashboardSummary,
  getBackgroundSettings,
  listBackgroundCheckDisputes,
  listBackgroundChecks,
  listOwnBackgroundChecks,
  listOwnBackgroundCheckDisputes,
  listCredentialReviewQueue,
  listCredentialTypes,
  listPersonCredentials,
  listRequirements,
  readBackgroundCheckDetails,
  recordManualResult,
  resendAdverseActionNotice,
  resolveBackgroundCheckDispute,
  reviewCredential,
  saveCheckrResult,
  saveBackgroundSettings,
  saveRequirement,
  sendPreAdverseNotice,
  submitBackgroundCheckDispute,
  submitCredential,
  updateCredentialSubmission,
  updateCredentialType,
  revokePersonCredential,
} from './service';
import type { ComplianceDependencies } from './service';

const pathId = (value: unknown) => z.uuid().parse(value);

export function createComplianceRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const platformCheckrEnabled =
    process.env.CHECKR_ENABLED === 'true' &&
    Boolean(process.env.CHECKR_API_KEY);
  const checkrApiKey = process.env.CHECKR_API_KEY;
  const checkr =
    platformCheckrEnabled && checkrApiKey
      ? new CheckrBackgroundCheckProvider({
          apiKey: checkrApiKey,
          baseUrl:
            process.env.CHECKR_BASE_URL ?? 'https://api.checkr-staging.com',
        })
      : undefined;
  const compliance: ComplianceDependencies = {
    database: dependencies.database,
    encryption: dependencies.encryption,
    email: dependencies.email,
    providers: {
      manual: new ManualBackgroundCheckProvider(),
      ...(checkr ? { checkr } : {}),
    },
    checkrEnabled: Boolean(checkr),
    ...(checkrApiKey ? { checkrWebhookSecret: checkrApiKey } : {}),
    clock: dependencies.clock,
    appUrl: dependencies.appUrl,
  };
  const cards = {
    database: dependencies.database,
    encryption: dependencies.encryption,
    clock: dependencies.clock,
    appUrl: dependencies.appUrl,
  };

  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.use((request, response, next) => {
    if (request.path === '/webhooks/checkr') {
      next();
      return;
    }
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
  const jsonParser = express.json({ limit: '32kb' });
  router.use((request, response, next) => {
    if (request.path === '/webhooks/checkr') {
      next();
      return;
    }
    jsonParser(request, response, next);
  });

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
        if (error instanceof CardError) {
          response
            .status(error.status)
            .json({ error: { code: error.code, message: error.message } });
          return;
        }
        sendModuleError(response, error);
      }
    };
  const officer = async (request: express.Request) => {
    const actor = await orgActor(dependencies, request);
    requireAnyRole(actor.roles, ['owner', 'compliance']);
    return actor;
  };
  const owner = async (request: express.Request) => {
    const actor = await orgActor(dependencies, request);
    requireAnyRole(actor.roles, ['owner']);
    if (
      !actor.session.elevatedUntil ||
      actor.session.elevatedUntil <= dependencies.clock()
    )
      throw new AccessError(
        403,
        'FORBIDDEN',
        'Confirm your identity before changing compliance settings',
      );
    return actor;
  };
  const requireElevated = (
    session: Awaited<ReturnType<typeof orgActor>>['session'],
  ) => {
    if (!session.elevatedUntil || session.elevatedUntil <= dependencies.clock())
      throw new AccessError(
        403,
        'FORBIDDEN',
        'Confirm your identity before taking this action',
      );
  };

  router.get(
    '/organizations/:orgId/dashboard',
    endpoint(async (request, response) => {
      const { context } = await officer(request);
      response.json(await dashboardSummary(dependencies.database, context));
    }),
  );
  router.get(
    '/organizations/:orgId/credential-types',
    endpoint(async (request, response) => {
      const { context } = await orgActor(dependencies, request);
      response.json(await listCredentialTypes(dependencies.database, context));
    }),
  );
  router.patch(
    '/organizations/:orgId/credential-types/:credentialTypeId',
    endpoint(async (request, response) => {
      const actor = await owner(request);
      const body = credentialTypeUpdateSchema.parse(request.body);
      response.json(
        await updateCredentialType(dependencies.database, actor.context, {
          id: pathId(request.params.credentialTypeId),
          ...body,
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/requirements',
    endpoint(async (request, response) => {
      const { context } = await officer(request);
      response.json(await listRequirements(dependencies.database, context));
    }),
  );
  router.post(
    '/organizations/:orgId/requirements',
    endpoint(async (request, response) => {
      const actor = await owner(request);
      const body = credentialRequirementSchema.parse(request.body);
      response.status(201).json(
        await saveRequirement(dependencies.database, actor.context, {
          role: body.role,
          credentialTypeId: body.credentialTypeId,
          scopeType: body.scopeType,
          scopeId: body.scopeId ?? null,
          minimumAge: body.minimumAge,
          active: body.active,
        }),
      );
    }),
  );
  router.patch(
    '/organizations/:orgId/requirements/:requirementId',
    endpoint(async (request, response) => {
      const actor = await owner(request);
      const body = requirementUpdateSchema.parse(request.body);
      const id = pathId(request.params.requirementId);
      if (body.id !== id)
        throw new AccessError(
          400,
          'VALIDATION_ERROR',
          'Requirement ID does not match the request',
        );
      response.json(
        await saveRequirement(dependencies.database, actor.context, {
          id,
          version: body.version,
          role: body.role,
          credentialTypeId: body.credentialTypeId,
          scopeType: body.scopeType,
          scopeId: body.scopeId ?? null,
          minimumAge: body.minimumAge,
          active: body.active,
        }),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/overrides',
    endpoint(async (request, response) => {
      const actor = await owner(request);
      const body = complianceOverrideSchema.parse(request.body);
      response.status(201).json(
        await createComplianceOverride(compliance, actor.context, {
          ...body,
          scopeId: body.scopeId ?? null,
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/credentials/review-queue',
    endpoint(async (request, response) => {
      const { context } = await officer(request);
      const status = z
        .enum(['pending_review', 'rejected', 'verified', 'expired'])
        .default('pending_review')
        .parse(request.query.status);
      response.json(
        await listCredentialReviewQueue(dependencies.database, context, status),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/credentials/:credentialId/review',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      const body = credentialReviewSchema.parse(request.body);
      const { reason, ...review } = body;
      response.json(
        await reviewCredential(compliance, actor.context, {
          credentialId: pathId(request.params.credentialId),
          ...review,
          ...(reason !== undefined ? { reason } : {}),
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/people/:personId/credentials',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const canManage = isComplianceOfficer(actor.roles);
      response.json(
        await listPersonCredentials(
          dependencies.database,
          actor.context,
          pathId(request.params.personId),
          canManage,
        ),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/credentials',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const input = credentialBodySchema.parse(request.body);
      response.status(201).json(
        await submitCredential(
          compliance,
          actor.context,
          {
            personId: input.personId,
            credentialTypeId: input.credentialTypeId,
            ...(input.identifier !== undefined
              ? { identifier: input.identifier }
              : {}),
            ...(input.issuedOn !== undefined
              ? { issuedOn: input.issuedOn }
              : {}),
            ...(input.expiresOn !== undefined
              ? { expiresOn: input.expiresOn }
              : {}),
            ...(input.fileId !== undefined ? { fileId: input.fileId } : {}),
          },
          isComplianceOfficer(actor.roles),
        ),
      );
    }),
  );
  router.patch(
    '/organizations/:orgId/credentials/:credentialId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = credentialSubmissionUpdateSchema.parse(request.body);
      const { identifier, ...correction } = body;
      response.json(
        await updateCredentialSubmission(
          compliance,
          actor.context,
          {
            credentialId: pathId(request.params.credentialId),
            ...correction,
            ...(identifier !== undefined ? { identifier } : {}),
          },
          isComplianceOfficer(actor.roles),
        ),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/credentials/:credentialId/revoke',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = credentialRevokeSchema.parse(request.body);
      response.json(
        await revokePersonCredential(
          dependencies.database,
          actor.context,
          { credentialId: pathId(request.params.credentialId), ...body },
          isComplianceOfficer(actor.roles),
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/background-check-settings',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await getBackgroundSettings(
          dependencies.database,
          actor.context,
          Boolean(checkr),
        ),
      );
    }),
  );
  router.patch(
    '/organizations/:orgId/background-check-settings',
    endpoint(async (request, response) => {
      const actor = await owner(request);
      const body = backgroundSettingsSchema.parse(request.body);
      response.json(
        await saveBackgroundSettings(
          dependencies.database,
          actor.context,
          Boolean(checkr),
          body,
        ),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/background-checks',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      response.json(
        await listBackgroundChecks(dependencies.database, actor.context),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/my-background-checks',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await listOwnBackgroundChecks(dependencies.database, actor.context),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/background-checks/:orderId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await readBackgroundCheckDetails(
          compliance,
          actor.context,
          pathId(request.params.orderId),
          isComplianceOfficer(actor.roles),
        ),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/background-checks',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = backgroundConsentSchema.parse(request.body);
      const userAgent = request.get('user-agent');
      response.status(201).json(
        await beginBackgroundCheck(compliance, actor.context, body, {
          ...(request.ip ? { ip: request.ip } : {}),
          ...(userAgent ? { userAgent } : {}),
        }),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/background-checks/:orderId/manual-result',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      const body = backgroundResultSchema.parse(request.body);
      const { details, ...result } = body;
      response.json(
        await recordManualResult(compliance, actor.context, {
          orderId: pathId(request.params.orderId),
          ...result,
          ...(details !== undefined ? { details } : {}),
        }),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/background-checks/:orderId/pre-adverse-notice',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      response.json(
        await sendPreAdverseNotice(
          compliance,
          actor.context,
          pathId(request.params.orderId),
        ),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/background-checks/:orderId/adverse-notice',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      response.json(
        await resendAdverseActionNotice(
          compliance,
          actor.context,
          pathId(request.params.orderId),
        ),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/background-checks/:orderId/adjudication',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      requireElevated(actor.session);
      response.json(
        await adjudicateBackgroundCheck(compliance, actor.context, {
          orderId: pathId(request.params.orderId),
          ...backgroundAdjudicationSchema.parse(request.body),
        }),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/background-checks/:orderId/disputes',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = z
        .strictObject({ statement: z.string().trim().min(10).max(20_000) })
        .parse(request.body);
      response
        .status(201)
        .json(
          await submitBackgroundCheckDispute(
            compliance,
            actor.context,
            pathId(request.params.orderId),
            body.statement,
          ),
        );
    }),
  );
  router.get(
    '/organizations/:orgId/background-checks/:orderId/disputes',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await listOwnBackgroundCheckDisputes(
          compliance,
          actor.context,
          pathId(request.params.orderId),
        ),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/background-check-disputes',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      response.json(
        await listBackgroundCheckDisputes(compliance, actor.context),
      );
    }),
  );
  router.patch(
    '/organizations/:orgId/background-check-disputes/:disputeId',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      const body = z
        .strictObject({
          resolution: z.string().trim().min(10).max(20_000),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      response.json(
        await resolveBackgroundCheckDispute(compliance, actor.context, {
          disputeId: pathId(request.params.disputeId),
          ...body,
        }),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/cards',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      const body = cardBodySchema.parse(request.body);
      response.status(201).json(
        await createCard(cards, actor.context, {
          personId: body.personId,
          cardKind: body.cardKind,
          programId: body.programId ?? null,
          seasonId: body.seasonId ?? null,
          cardNumber: body.cardNumber,
          validUntil: body.validUntil,
          photoFileId: body.photoFileId ?? null,
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/people/:personId/cards',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await listCards(cards, actor.context, pathId(request.params.personId)),
      );
    }),
  );
  router.patch(
    '/organizations/:orgId/cards/:cardId',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      const body = cardStatusSchema.parse(request.body);
      if (body.status !== 'revoked')
        throw new AccessError(
          400,
          'VALIDATION_ERROR',
          'Cards can only be revoked',
        );
      const id = pathId(request.params.cardId);
      response.json(
        await revokeCard(
          dependencies.database,
          actor.context,
          id,
          body.version,
        ),
      );
    }),
  );
  router.get(
    '/cards/verify/:token',
    endpoint(async (request, response) => {
      response.json(
        await verifyCard(
          dependencies.database,
          z.string().min(30).max(1000).parse(request.params.token),
          dependencies.encryption,
          dependencies.clock(),
        ),
      );
    }),
  );
  router.get(
    '/cards/verify/:token/photo',
    endpoint(async (request, response) => {
      const photo = await readCardPhoto(
        cards,
        z.string().min(30).max(1000).parse(request.params.token),
      );
      response
        .type(photo.mime)
        .set('Cache-Control', 'private, no-store')
        .send(Buffer.from(photo.bytes));
    }),
  );

  router.post(
    '/webhooks/checkr',
    express.raw({ type: 'application/json', limit: '128kb' }),
    endpoint(async (request, response) => {
      if (!checkr || !compliance.checkrWebhookSecret)
        throw new AccessError(404, 'NOT_FOUND', 'Webhook is not configured');
      if (!Buffer.isBuffer(request.body))
        throw new AccessError(
          400,
          'VALIDATION_ERROR',
          'Webhook body is missing',
        );
      const signature = request.get('X-Checkr-Signature') ?? '';
      const expected = createHmac('sha256', compliance.checkrWebhookSecret)
        .update(request.body)
        .digest();
      let supplied: Buffer;
      try {
        supplied = Buffer.from(signature, 'hex');
      } catch {
        supplied = Buffer.alloc(0);
      }
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        throw new AccessError(
          401,
          'UNAUTHENTICATED',
          'Webhook signature is invalid',
        );
      const event = z
        .object({
          id: z.string().min(1).max(200),
          type: z.string().min(1).max(100),
          created_at: z.iso.datetime().optional(),
          data: z
            .object({ object: z.record(z.string(), z.unknown()) })
            .optional(),
        })
        .loose()
        .parse(JSON.parse(request.body.toString('utf8')) as unknown);
      if (
        event.type !== 'report.completed' &&
        event.type !== 'report.suspended' &&
        event.type !== 'report.resumed'
      ) {
        response.status(202).json({ received: true, ignored: true });
        return;
      }
      const report = event.data?.object;
      if (!report || typeof report.id !== 'string')
        throw new AccessError(
          503,
          'PROVIDER_EVENT_INCOMPLETE',
          'Checkr event needs include_object enabled',
        );
      const status =
        event.type === 'report.suspended'
          ? 'suspended'
          : event.type === 'report.resumed'
            ? 'pending'
            : report.result === 'clear'
              ? 'clear'
              : report.result === 'consider'
                ? 'consider'
                : null;
      if (!status)
        throw new AccessError(
          503,
          'PROVIDER_EVENT_INCOMPLETE',
          'Checkr report result is unavailable',
        );
      const reportCompletedAt = z.iso.datetime().safeParse(report.completed_at);
      const locator = await dependencies.database
        .transaction()
        .execute(async (trx) => {
          await sql`select set_config('app.safety_webhook_lookup', 'true', true)`.execute(
            trx,
          );
          return trx
            .selectFrom('background_check_provider_index')
            .select(['org_id', 'order_id'])
            .where('provider', '=', 'checkr')
            .where('report_id', '=', report.id as string)
            .executeTakeFirst();
        });
      if (!locator) {
        response.status(202).json({ received: true, ignored: true });
        return;
      }
      const providerContext = {
        orgId: locator.org_id,
        actor: { accountId: locator.org_id },
      };
      const saved = await saveCheckrResult(compliance, providerContext, {
        providerEventId: event.id,
        reportId: report.id,
        status,
        ...(reportCompletedAt.success &&
        status !== 'pending' &&
        status !== 'suspended'
          ? { completedAt: reportCompletedAt.data }
          : {}),
      });
      response.status(202).json({ received: true, saved });
    }),
  );

  return router;
}
