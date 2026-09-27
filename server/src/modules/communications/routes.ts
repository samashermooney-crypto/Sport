import { randomUUID } from 'node:crypto';

import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import { sql } from 'kysely';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { verifyResendWebhook } from '../../integrations/email/sender';
import {
  parseTwilioInbound,
  verifyTwilioStatusCallback,
} from '../../integrations/sms/sender';
import { appendAuditEvent } from '../audit/service';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';
import {
  chatMessageCreateSchema,
  chatMessageEditSchema,
  chatMessageListSchema,
  chatAttachmentCapabilitiesSchema,
  chatMemberOptionsSchema,
  chatModerationListSchema,
  chatModerationUpdateSchema,
  chatReportResponseSchema,
  chatReportSchema,
  conversationCreateSchema,
  conversationListSchema,
  conversationSchema,
} from '../chat/schema';
import {
  createConversation,
  editMessage,
  ensureTeamConversation,
  ensureTeamStaffConversation,
  getChatAttachmentCapabilities,
  listHouseholdMessageHistory,
  listChatMemberOptions,
  listConversations,
  listAvailableTeams,
  listMessages,
  listPersonMessageHistory,
  markConversationRead,
  moderationReports,
  reportMessage,
  sendChatMessage,
  setConversationMuted,
  softDeleteMessage,
  updateReportStatus,
} from '../chat/service';

import {
  createCommunicationAdapters,
  createCommunicationNotificationSink,
} from './adapters';
import {
  recordWebhookStatus,
  sendCampaign,
  sendCampaignTest,
  verifyUnsubscribeToken,
} from './delivery';
import type { DeliveryDependencies } from './delivery';
import {
  campaignDraftSchema,
  campaignPreviewSchema,
  campaignStatsSchema,
  campaignSummarySchema,
  audienceOptionsSchema,
  sendCampaignSchema,
  scheduleCampaignSchema,
  smsConsentSchema,
  senderIdentitySchema,
  senderIdentityResponseSchema,
  personCommunicationHistorySchema,
  verificationTokenSchema,
} from './schema';
import {
  cancelCampaign,
  createCampaign,
  getCampaignDetail,
  getCampaignStats,
  listAudienceOptions,
  listCampaigns,
  previewCampaign,
  scheduleCampaign,
  updateCampaign,
} from './service';
import {
  getSmsConsent,
  getSenderIdentity,
  revokeSmsConsent,
  setSmsConsent,
  unsubscribeFromCategory,
  updateSenderIdentity,
  verifySenderIdentity,
} from './settings';

export type CommunicationsRouteOptions = {
  delivery?: DeliveryDependencies;
};

function mutationOriginIsValid(
  request: express.Request,
  appUrl: string,
): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && request.get('Origin') === undefined))
  );
}

function sendError(response: express.Response, error: unknown) {
  const status =
    error instanceof z.ZodError || error instanceof RangeError
      ? 400
      : error &&
          typeof error === 'object' &&
          'status' in error &&
          typeof error.status === 'number'
        ? error.status
        : 500;
  const code =
    status === 400
      ? 'VALIDATION_ERROR'
      : status === 401
        ? 'UNAUTHENTICATED'
        : status === 403
          ? 'FORBIDDEN'
          : status === 404
            ? 'NOT_FOUND'
            : status === 409
              ? 'CONFLICT'
              : status === 503
                ? 'DEPENDENCY_UNAVAILABLE'
                : 'INTERNAL_ERROR';
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code,
        message:
          status >= 500
            ? 'The request could not be completed'
            : error instanceof Error
              ? error.message
              : 'Request failed',
      },
    }),
  );
}

function requestContext(orgId: string, accountId: string): OrgContext {
  return { orgId, actor: { accountId } };
}

async function sessionContext(
  dependencies: AuthDependencies,
  request: express.Request,
) {
  const session = await requireSession(dependencies, request);
  const orgId = z.uuid().parse(request.params.orgId);
  return { session, context: requestContext(orgId, session.accountId) };
}

function safeParams(request: express.Request) {
  return {
    campaignId: z.uuid().parse(request.params.campaignId),
    orgId: z.uuid().parse(request.params.orgId),
  };
}

async function providerLocator(
  dependencies: AuthDependencies,
  channel: 'email' | 'sms',
  providerId: string,
) {
  // This table is a non-tenant opaque locator. The matching delivery is only
  // accessed after switching into its organization with withOrg.
  const rows = await sql<{ tenant_org_id: string; delivery_id: string }>`
    SELECT tenant_org_id, delivery_id FROM provider_delivery_keys WHERE channel = ${channel} AND provider_id = ${providerId}
  `.execute(dependencies.database);
  return rows.rows[0] ?? null;
}

export async function applyTwilioCommand(
  dependencies: Pick<AuthDependencies, 'database'>,
  runWithOrg: ReturnType<typeof createWithOrg>,
  phone: string,
  action: 'granted' | 'revoked',
  providerMessageId: string,
) {
  const accounts = await dependencies.database
    .selectFrom('accounts')
    .select('id')
    .where('phone_e164', '=', phone)
    .execute();
  const orgs = await dependencies.database
    .selectFrom('organizations')
    .select('id')
    .where('status', '=', 'active')
    .orderBy('id')
    .execute();
  const firstOrg = orgs[0];
  if (firstOrg) {
    const actor = accounts[0]?.id ?? '00000000-0000-0000-0000-000000000000';
    await runWithOrg(requestContext(firstOrg.id, actor), async (trx) => {
      if (action === 'revoked') {
        await sql`INSERT INTO suppressions(id, org_id, channel, address, reason) VALUES (gen_random_uuid(), NULL, 'sms', ${phone}, 'stop') ON CONFLICT (org_id, channel, address) DO NOTHING`.execute(
          trx,
        );
      } else {
        await trx
          .deleteFrom('suppressions')
          .where('org_id', 'is', null)
          .where('channel', '=', 'sms')
          .where('address', '=', phone)
          .where('reason', '=', 'stop')
          .execute();
      }
    });
  }
  for (const account of accounts) {
    for (const org of orgs) {
      const context = requestContext(org.id, account.id);
      await runWithOrg(context, async (trx) => {
        const membership = await trx
          .selectFrom('org_memberships')
          .select('id')
          .where('org_id', '=', org.id)
          .where('account_id', '=', account.id)
          .where('status', '=', 'active')
          .executeTakeFirst();
        const link = await trx
          .selectFrom('person_account_links')
          .select('id')
          .where('org_id', '=', org.id)
          .where('account_id', '=', account.id)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (!membership && !link) return;
        const locale = await trx
          .selectFrom('accounts')
          .select('locale')
          .where('id', '=', account.id)
          .executeTakeFirst();
        const spanish = locale?.locale === 'es';
        const consentText =
          action === 'revoked'
            ? spanish
              ? 'La persona respondió STOP por SMS para retirar el consentimiento.'
              : 'The recipient replied STOP by SMS to withdraw consent.'
            : spanish
              ? 'La persona respondió START por SMS para volver a recibir mensajes.'
              : 'The recipient replied START by SMS to opt in again.';
        const recorded = await sql<{
          id: string;
        }>`INSERT INTO communication_consent_events(id, org_id, account_id, phone_e164, action, source, version, provider_message_id, consent_text) VALUES (${randomUUID()}, ${org.id}, ${account.id}, ${phone}, ${action}, ${action === 'revoked' ? 'twilio_stop' : 'twilio_start'}, 'sms-keyword-v1', ${providerMessageId}, ${consentText}) ON CONFLICT (org_id, account_id, source, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING RETURNING id`.execute(
          trx,
        );
        if (recorded.rows[0])
          await appendAuditEvent(trx, context, {
            action:
              action === 'revoked'
                ? 'communication.sms_consent.stop'
                : 'communication.sms_consent.start',
            entityType: 'communication_consent',
            changes: { evidence: { tier: 'internal', after: '[recorded]' } },
          });
      });
    }
  }
}

export function createCommunicationsRouter(
  dependencies: AuthDependencies,
  options: CommunicationsRouteOptions = {},
): express.Router {
  const router = express.Router();
  const withOrg = createWithOrg(dependencies.database);
  const configuredDelivery =
    options.delivery ??
    createCommunicationAdapters({
      email: dependencies.email,
      appUrl: dependencies.appUrl,
      runWithOrg: withOrg,
    });
  const delivery: DeliveryDependencies = {
    ...configuredDelivery,
    notifications:
      configuredDelivery.notifications ??
      createCommunicationNotificationSink(withOrg),
  };
  const chat = {
    encryption: dependencies.encryption,
    ...(delivery.notifications
      ? {
          notifications: async ({
            context,
            accountId,
            conversationId,
            messageId,
          }: {
            context: OrgContext;
            accountId: string;
            conversationId: string;
            messageId: string;
          }) => {
            await delivery.notifications?.({
              context,
              accountId,
              type: 'communications.chat_message',
              payload: { conversationId, messageId },
            });
          },
        }
      : {}),
  };

  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.post(
    '/webhooks/resend',
    express.raw({ type: 'application/json', limit: '256kb' }),
    async (request, response) => {
      try {
        const raw: unknown = request.body;
        const secret = process.env.RESEND_WEBHOOK_SECRET;
        if (!Buffer.isBuffer(raw) || !secret)
          throw Object.assign(new Error('Webhook is not configured'), {
            status: 503,
          });
        const event = verifyResendWebhook({
          rawBody: raw,
          id: request.get('svix-id') ?? '',
          timestamp: request.get('svix-timestamp') ?? '',
          signature: request.get('svix-signature') ?? '',
          secret,
          now: Math.floor(dependencies.clock().getTime() / 1000),
        });
        const locator = await providerLocator(
          dependencies,
          'email',
          event.data.email_id,
        );
        if (!locator) {
          response.status(202).json({ accepted: true });
          return;
        }
        await recordWebhookStatus(
          requestContext(
            locator.tenant_org_id,
            '00000000-0000-0000-0000-000000000000',
          ),
          event.data.email_id,
          'email',
          event.type,
          dependencies.clock(),
          withOrg,
        );
        response.status(202).json({ accepted: true });
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.use(express.json({ limit: '256kb' }));
  router.use(express.urlencoded({ extended: false, limit: '32kb' }));
  router.use((request, response, next) => {
    if (
      request.path.startsWith('/webhooks/') ||
      request.path.startsWith('/unsubscribe/') ||
      request.path.startsWith('/sender/verify')
    ) {
      next();
      return;
    }
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !mutationOriginIsValid(request, dependencies.appUrl)
    ) {
      response.status(403).json(
        apiErrorSchema.parse({
          error: {
            code: 'FORBIDDEN',
            message: 'Request origin could not be verified',
          },
        }),
      );
      return;
    }
    next();
  });

  router.get('/orgs/:orgId/campaigns', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      response.json(await listCampaigns(context, withOrg));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/orgs/:orgId/audience-options', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      const search =
        request.query.search === undefined
          ? ''
          : z.string().max(80).parse(request.query.search);
      response.json(
        audienceOptionsSchema.parse(
          await listAudienceOptions(context, search, withOrg),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/orgs/:orgId/campaigns', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      const result = await createCampaign(
        context,
        campaignDraftSchema.parse(request.body as unknown),
        dependencies.appUrl,
        withOrg,
      );
      response.status(201).json(campaignSummarySchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get(
    '/orgs/:orgId/campaigns/:campaignId',
    async (request, response) => {
      try {
        const { context, campaignId } = {
          ...(await sessionContext(dependencies, request)),
          ...safeParams(request),
        };
        response.json(await getCampaignDetail(context, campaignId, withOrg));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.put(
    '/orgs/:orgId/campaigns/:campaignId',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const { campaignId } = safeParams(request);
        const body = z
          .strictObject({
            draft: campaignDraftSchema,
            expectedVersion: z.number().int().positive(),
          })
          .parse(request.body as unknown);
        response.json(
          await updateCampaign(
            context,
            campaignId,
            body.draft,
            body.expectedVersion,
            dependencies.appUrl,
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/campaigns/:campaignId/preview',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const { campaignId } = safeParams(request);
        response.json(
          campaignPreviewSchema.parse(
            await previewCampaign(
              context,
              campaignId,
              dependencies.clock(),
              withOrg,
            ),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/campaigns/:campaignId/test-send',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const { campaignId } = safeParams(request);
        await getCampaignDetail(context, campaignId, withOrg);
        response.json(
          await sendCampaignTest(
            context,
            campaignId,
            delivery,
            dependencies.clock(),
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/campaigns/:campaignId/send',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const { campaignId } = safeParams(request);
        const body = sendCampaignSchema.parse(request.body as unknown);
        const preview = await previewCampaign(
          context,
          campaignId,
          dependencies.clock(),
          withOrg,
        );
        const actualCounts = preview.counts as Record<string, number>;
        const confirmedCounts = body.confirmRecipientCounts as
          Record<string, number> | undefined;
        if (
          !confirmedCounts ||
          Object.keys(actualCounts).some(
            (channel) => confirmedCounts[channel] !== actualCounts[channel],
          )
        ) {
          response.status(409).json(
            apiErrorSchema.parse({
              error: {
                code: 'CONFLICT',
                message:
                  'Audience changed; review recipient counts before sending',
              },
            }),
          );
          return;
        }
        response.json(
          await sendCampaign(
            context,
            campaignId,
            body.expectedVersion,
            delivery,
            {
              ...(body.confirmEmergency ? { confirmEmergency: true } : {}),
              now: dependencies.clock(),
              runWithOrg: withOrg,
            },
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/campaigns/:campaignId/schedule',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const { campaignId } = safeParams(request);
        const body = scheduleCampaignSchema.parse(request.body as unknown);
        response.json(
          await scheduleCampaign(
            context,
            campaignId,
            new Date(body.scheduledFor),
            body.expectedVersion,
            dependencies.clock(),
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/campaigns/:campaignId/cancel',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const { campaignId } = safeParams(request);
        const body = z
          .strictObject({ expectedVersion: z.number().int().positive() })
          .parse(request.body as unknown);
        response.json(
          await cancelCampaign(
            context,
            campaignId,
            body.expectedVersion,
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/campaigns/:campaignId/stats',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const { campaignId } = safeParams(request);
        response.json(
          campaignStatsSchema.parse(
            await getCampaignStats(context, campaignId, withOrg),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/people/:personId/history',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const personId = z.uuid().parse(request.params.personId);
        response.json(
          personCommunicationHistorySchema.parse(
            await listPersonMessageHistory(context, personId, withOrg),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/households/:householdId/history',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const householdId = z.uuid().parse(request.params.householdId);
        response.json(
          personCommunicationHistorySchema.parse(
            await listHouseholdMessageHistory(context, householdId, withOrg),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get('/orgs/:orgId/sender-identity', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      response.json(
        senderIdentityResponseSchema.parse(
          await getSenderIdentity(context, withOrg),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.put('/orgs/:orgId/sender-identity', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      const body = senderIdentitySchema.parse(request.body as unknown);
      response.json(
        await updateSenderIdentity(
          context,
          body,
          dependencies.appUrl,
          dependencies.email,
          dependencies.clock(),
          withOrg,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/sender/verify/:token', (request, response) => {
    try {
      const token = verificationTokenSchema.parse({
        token: request.params.token,
      }).token;
      response
        .status(200)
        .type('html')
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Verify sender address</title><main><h1>Verify reply-to address</h1><p>Confirm this address for organization messages.</p><form method="post" action="/api/v1/communications/sender/verify/${encodeURIComponent(token)}"><button type="submit">Verify address</button></form></main></html>`,
        );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/sender/verify/:token', async (request, response) => {
    try {
      const token = verificationTokenSchema.parse({
        token: request.params.token,
      }).token;
      await verifySenderIdentity(token, dependencies.clock(), withOrg);
      response
        .status(200)
        .type('text')
        .send('Reply-to address verified. You can close this page.');
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/orgs/:orgId/sms-consent', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      response.json(await getSmsConsent(context, withOrg));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/orgs/:orgId/sms-consent', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      const body = smsConsentSchema.parse(request.body as unknown);
      const userAgent = request.get('user-agent');
      response.json(
        await setSmsConsent(
          context,
          body,
          {
            ...(request.ip ? { ip: request.ip } : {}),
            ...(userAgent ? { userAgent } : {}),
          },
          withOrg,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.delete('/orgs/:orgId/sms-consent', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      const userAgent = request.get('user-agent');
      response.json(
        await revokeSmsConsent(
          context,
          {
            ...(request.ip ? { ip: request.ip } : {}),
            ...(userAgent ? { userAgent } : {}),
          },
          withOrg,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/unsubscribe/:token', (request, response) => {
    try {
      const token = z.string().min(1).max(2048).parse(request.params.token);
      verifyUnsubscribeToken(token, dependencies.clock());
      response
        .status(200)
        .type('html')
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Confirm unsubscribe</title><main><h1>Unsubscribe from this category</h1><p>Confirm to stop these non-essential organization emails.</p><form method="post" action="/api/v1/communications/unsubscribe/${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form></main></html>`,
        );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/unsubscribe/:token', async (request, response) => {
    try {
      const token = z.string().min(1).max(2048).parse(request.params.token);
      await unsubscribeFromCategory(token, dependencies.clock(), withOrg);
      response
        .status(200)
        .type('text')
        .send('You are unsubscribed from this email category.');
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/webhooks/twilio/status', async (request, response) => {
    try {
      const secret = process.env.TWILIO_AUTH_TOKEN;
      const callbackUrl = process.env.TWILIO_STATUS_CALLBACK_URL;
      if (!secret || !callbackUrl)
        throw Object.assign(new Error('Twilio webhook is not configured'), {
          status: 503,
        });
      const params = Object.fromEntries(
        Object.entries(request.body as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      const event = verifyTwilioStatusCallback({
        url: callbackUrl,
        params,
        signature: request.get('x-twilio-signature') ?? '',
        authToken: secret,
      });
      const locator = await providerLocator(
        dependencies,
        'sms',
        event.providerId,
      );
      if (!locator) {
        response.status(204).end();
        return;
      }
      await recordWebhookStatus(
        requestContext(
          locator.tenant_org_id,
          '00000000-0000-0000-0000-000000000000',
        ),
        event.providerId,
        'sms',
        event.status,
        dependencies.clock(),
        withOrg,
      );
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/webhooks/twilio/inbound', async (request, response) => {
    try {
      const secret = process.env.TWILIO_AUTH_TOKEN;
      const callbackUrl = process.env.TWILIO_INBOUND_CALLBACK_URL;
      if (!secret || !callbackUrl)
        throw Object.assign(new Error('Twilio webhook is not configured'), {
          status: 503,
        });
      const params = Object.fromEntries(
        Object.entries(request.body as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      const message = parseTwilioInbound({
        url: callbackUrl,
        params,
        signature: request.get('x-twilio-signature') ?? '',
        authToken: secret,
      });
      if (message.command === 'STOP')
        await applyTwilioCommand(
          dependencies,
          withOrg,
          message.from,
          'revoked',
          message.messageSid,
        );
      if (message.command === 'START')
        await applyTwilioCommand(
          dependencies,
          withOrg,
          message.from,
          'granted',
          message.messageSid,
        );
      const text =
        message.command === 'HELP'
          ? 'Athlentry messages. Reply STOP to opt out; message and data rates may apply.'
          : message.command === 'STOP'
            ? 'You are opted out and will not receive further SMS messages.'
            : message.command === 'START'
              ? 'You are opted in to receive SMS messages. Reply STOP to opt out.'
              : '';
      response
        .status(200)
        .type('application/xml')
        .send(
          text
            ? `<Response><Message>${text}</Message></Response>`
            : '<Response/>',
        );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/chat/conversations', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      response.json(
        conversationListSchema.parse(await listConversations(context, withOrg)),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/orgs/:orgId/chat/member-options', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      const search = z.string().max(100).optional().parse(request.query.search);
      response.json(
        chatMemberOptionsSchema.parse(
          await listChatMemberOptions(context, search ?? '', withOrg),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get(
    '/orgs/:orgId/chat/attachment-capabilities',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        response.json(
          chatAttachmentCapabilitiesSchema.parse(
            await getChatAttachmentCapabilities(context, withOrg),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get('/orgs/:orgId/chat/teams', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      response.json(
        z
          .strictObject({
            items: z.array(
              z.strictObject({
                teamSeasonId: z.uuid(),
                label: z.string(),
                staffAccess: z.boolean(),
              }),
            ),
          })
          .parse(await listAvailableTeams(context, withOrg)),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/orgs/:orgId/chat/conversations', async (request, response) => {
    try {
      const { context } = await sessionContext(dependencies, request);
      const body = conversationCreateSchema.parse(request.body as unknown);
      const conversation =
        body.kind === 'team' && body.teamSeasonId
          ? await ensureTeamConversation(
              context,
              body.teamSeasonId,
              dependencies.clock(),
              withOrg,
            )
          : body.kind === 'team_staff' && body.teamSeasonId
            ? await ensureTeamStaffConversation(
                context,
                body.teamSeasonId,
                dependencies.clock(),
                withOrg,
              )
            : await createConversation(
                context,
                {
                  kind: body.kind,
                  accountIds: body.accountIds,
                  ...(body.teamSeasonId !== undefined
                    ? { teamSeasonId: body.teamSeasonId }
                    : {}),
                  ...(body.title !== undefined ? { title: body.title } : {}),
                },
                dependencies.clock(),
                withOrg,
              );
      response.status(201).json(conversationSchema.parse(conversation));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get(
    '/orgs/:orgId/chat/conversations/:conversationId/messages',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const id = z.uuid().parse(request.params.conversationId);
        const limit =
          request.query.limit === undefined
            ? 50
            : z.coerce
                .number()
                .int()
                .min(1)
                .max(100)
                .parse(request.query.limit);
        const cursor =
          request.query.cursor === undefined
            ? undefined
            : z.string().min(1).max(1024).parse(request.query.cursor);
        response.json(
          chatMessageListSchema.parse(
            await listMessages(
              context,
              id,
              { limit, ...(cursor ? { cursor } : {}) },
              withOrg,
            ),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/chat/conversations/:conversationId/messages',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const id = z.uuid().parse(request.params.conversationId);
        const body = chatMessageCreateSchema.parse(request.body as unknown);
        response
          .status(201)
          .json(
            await sendChatMessage(
              context,
              id,
              body,
              chat,
              dependencies.clock(),
              withOrg,
            ),
          );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/chat/conversations/:conversationId/read',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        response.json(
          await markConversationRead(
            context,
            z.uuid().parse(request.params.conversationId),
            dependencies.clock(),
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.put(
    '/orgs/:orgId/chat/conversations/:conversationId/mute',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const body = z
          .strictObject({ muted: z.boolean() })
          .parse(request.body as unknown);
        response.json(
          await setConversationMuted(
            context,
            z.uuid().parse(request.params.conversationId),
            body.muted,
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.put(
    '/orgs/:orgId/chat/conversations/:conversationId/messages/:messageId',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const body = chatMessageEditSchema.parse(request.body as unknown);
        response.json(
          await editMessage(
            context,
            z.uuid().parse(request.params.conversationId),
            z.uuid().parse(request.params.messageId),
            body.body,
            body.expectedVersion,
            dependencies.clock(),
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.delete(
    '/orgs/:orgId/chat/conversations/:conversationId/messages/:messageId',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        response.json(
          await softDeleteMessage(
            context,
            z.uuid().parse(request.params.conversationId),
            z.uuid().parse(request.params.messageId),
            dependencies.clock(),
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/chat/conversations/:conversationId/messages/:messageId/report',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const body = chatReportSchema.parse(request.body as unknown);
        response.status(201).json(
          chatReportResponseSchema.parse(
            await reportMessage(
              context,
              z.uuid().parse(request.params.conversationId),
              z.uuid().parse(request.params.messageId),
              {
                reason: body.reason,
                ...(body.details ? { details: body.details } : {}),
              },
              dependencies.encryption,
              dependencies.clock(),
              withOrg,
            ),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/chat/moderation/reports',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        response.json(
          chatModerationListSchema.parse(
            await moderationReports(context, withOrg),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.put(
    '/orgs/:orgId/chat/moderation/reports/:reportId',
    async (request, response) => {
      try {
        const { context } = await sessionContext(dependencies, request);
        const body = chatModerationUpdateSchema.parse(request.body as unknown);
        response.json(
          await updateReportStatus(
            context,
            z.uuid().parse(request.params.reportId),
            body.status,
            body.expectedVersion,
            withOrg,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  return router;
}
