import { z } from 'zod';

import { createMailpitEmailSender } from '../../integrations/email/sender';
import type { ServerModule } from '../../lib/module-contract';
import {
  chatModerationListSchema,
  chatAttachmentCapabilitiesSchema,
  chatMemberOptionsSchema,
  conversationCreateSchema,
  conversationListSchema,
  conversationSchema,
  chatMessageListSchema,
} from '../chat/schema';
import type { RegisteredJob } from '../jobs/registry';

import { createCommunicationAdapters } from './adapters';
import { deliverDueCampaigns } from './delivery';
import { createCommunicationsRouter } from './routes';
import {
  audienceOptionsSchema,
  campaignAudiencePreviewSchema,
  campaignDetailSchema,
  campaignDraftSchema,
  campaignListSchema,
  campaignPreviewSchema,
  campaignStatsSchema,
  campaignSummarySchema,
  phase10NotificationTemplates,
  sendCampaignSchema,
} from './schema';
import {
  personCommunicationHistorySchema,
  senderIdentityResponseSchema,
  senderIdentitySchema,
  smsConsentResponseSchema,
} from './schema';

const objectResponse = z.record(z.string(), z.unknown());
const routes = [
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/chat/attachment-capabilities',
    summary: 'Get chat attachment permissions for the current account',
    response: chatAttachmentCapabilitiesSchema,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/chat/member-options',
    summary: 'Search organization accounts for chat channel membership',
    response: chatMemberOptionsSchema,
    query: { search: z.string().max(100).optional() },
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/audience-options',
    summary: 'Search people, teams and programs for campaign targeting',
    response: audienceOptionsSchema,
    query: { search: z.string().optional() },
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/audience-preview',
    summary: 'Preview current campaign audience and eligible channels',
    body: campaignAudiencePreviewSchema,
    response: campaignPreviewSchema,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/campaigns',
    summary: 'List organization campaigns',
    response: campaignListSchema,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/campaigns',
    summary: 'Create a bilingual campaign draft',
    body: campaignDraftSchema,
    response: campaignSummarySchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/campaigns/{campaignId}',
    summary: 'Get campaign draft',
    response: campaignDetailSchema,
  },
  {
    method: 'put',
    path: '/api/v1/communications/orgs/{orgId}/campaigns/{campaignId}',
    summary: 'Update campaign draft',
    body: z.strictObject({
      draft: campaignDraftSchema,
      expectedVersion: z.number().int().positive(),
    }),
    response: campaignSummarySchema,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/campaigns/{campaignId}/preview',
    summary: 'Preview campaign audience and channel counts',
    response: campaignPreviewSchema,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/campaigns/{campaignId}/test-send',
    summary: 'Send campaign test to the signed-in sender',
    response: z.strictObject({
      testedAt: z.iso.datetime({ offset: true }),
      results: z.array(
        z.strictObject({ channel: z.string(), status: z.string() }),
      ),
    }),
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/campaigns/{campaignId}/send',
    summary: 'Send campaign after audience confirmation',
    body: sendCampaignSchema,
    response: objectResponse,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/campaigns/{campaignId}/schedule',
    summary: 'Schedule a campaign',
    body: z.object({
      scheduledFor: z.iso.datetime({ offset: true }),
      expectedVersion: z.number().int().positive(),
    }),
    response: campaignSummarySchema,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/campaigns/{campaignId}/cancel',
    summary: 'Cancel a scheduled campaign',
    body: z.strictObject({ expectedVersion: z.number().int().positive() }),
    response: campaignSummarySchema,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/campaigns/{campaignId}/stats',
    summary: 'Get delivery statistics',
    response: campaignStatsSchema,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/people/{personId}/history',
    summary: 'Get communication history for a person',
    response: personCommunicationHistorySchema,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/households/{householdId}/history',
    summary: 'Get communication history for a household',
    response: personCommunicationHistorySchema,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/sender-identity',
    summary: 'Get organization sender identity',
    response: senderIdentityResponseSchema,
  },
  {
    method: 'put',
    path: '/api/v1/communications/orgs/{orgId}/sender-identity',
    summary: 'Update sender identity and verify reply-to',
    body: senderIdentitySchema,
    response: z.strictObject({
      identity: senderIdentityResponseSchema,
      verificationSent: z.boolean(),
    }),
  },
  {
    method: 'get',
    path: '/api/v1/communications/sender/verify/{token}',
    summary: 'Verify a sender reply-to address',
    response: z.string(),
    public: true,
  },
  {
    method: 'post',
    path: '/api/v1/communications/sender/verify/{token}',
    summary: 'Confirm a sender reply-to address',
    response: z.string(),
    public: true,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/sms-consent',
    summary: 'Get current account SMS consent',
    response: smsConsentResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/sms-consent',
    summary: 'Record SMS consent for a verified phone',
    body: z.object({
      phoneE164: z.string(),
      accepted: z.literal(true),
      version: z.string(),
    }),
    response: smsConsentResponseSchema,
  },
  {
    method: 'delete',
    path: '/api/v1/communications/orgs/{orgId}/sms-consent',
    summary: 'Revoke SMS consent',
    response: smsConsentResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/communications/unsubscribe/{token}',
    summary: 'Confirm a tokenized email unsubscribe',
    response: z.string(),
    public: true,
  },
  {
    method: 'post',
    path: '/api/v1/communications/unsubscribe/{token}',
    summary: 'Apply a tokenized email unsubscribe',
    response: z.string(),
    public: true,
  },
  {
    method: 'post',
    path: '/api/v1/communications/webhooks/resend',
    summary: 'Process signed Resend delivery events',
    response: objectResponse,
    public: true,
  },
  {
    method: 'post',
    path: '/api/v1/communications/webhooks/twilio/status',
    summary: 'Process signed Twilio delivery callbacks',
    response: z.null(),
    public: true,
  },
  {
    method: 'post',
    path: '/api/v1/communications/webhooks/twilio/inbound',
    summary: 'Process signed Twilio STOP, START and HELP commands',
    response: z.string(),
    public: true,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations',
    summary: 'List conversations',
    response: conversationListSchema,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/chat/teams',
    summary: 'List teams available to the current account',
    response: z.strictObject({
      items: z.array(
        z.strictObject({
          teamSeasonId: z.uuid(),
          label: z.string(),
          staffAccess: z.boolean(),
        }),
      ),
    }),
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations',
    summary: 'Create or open a conversation',
    body: conversationCreateSchema,
    response: conversationSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations/{conversationId}/messages',
    summary: 'List conversation messages',
    response: chatMessageListSchema,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations/{conversationId}/messages',
    summary: 'Send a conversation message',
    body: z.object({ body: z.string(), attachments: z.array(z.uuid()) }),
    response: objectResponse,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations/{conversationId}/read',
    summary: 'Mark a conversation read',
    response: objectResponse,
  },
  {
    method: 'put',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations/{conversationId}/mute',
    summary: 'Mute or unmute a conversation',
    body: z.strictObject({ muted: z.boolean() }),
    response: objectResponse,
  },
  {
    method: 'put',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations/{conversationId}/messages/{messageId}',
    summary: 'Edit an authored message',
    body: z.strictObject({
      body: z.string(),
      expectedVersion: z.number().int().positive(),
    }),
    response: objectResponse,
  },
  {
    method: 'delete',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations/{conversationId}/messages/{messageId}',
    summary: 'Hide a message',
    response: objectResponse,
  },
  {
    method: 'post',
    path: '/api/v1/communications/orgs/{orgId}/chat/conversations/{conversationId}/messages/{messageId}/report',
    summary: 'Report a message to compliance',
    body: z.object({ reason: z.string(), details: z.string().optional() }),
    response: objectResponse,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/communications/orgs/{orgId}/chat/moderation/reports',
    summary: 'List compliance chat reports',
    response: chatModerationListSchema,
  },
  {
    method: 'put',
    path: '/api/v1/communications/orgs/{orgId}/chat/moderation/reports/{reportId}',
    summary: 'Update a compliance report status',
    body: z.object({
      status: z.string(),
      expectedVersion: z.number().int().positive(),
    }),
    response: objectResponse,
  },
] as const;

const jobs = [
  {
    name: 'communications.deliver-due',
    cron: '* * * * *',
    run: async () => {
      const dependencies =
        process.env.DELIVERY_MODE === 'live'
          ? createCommunicationAdapters()
          : createCommunicationAdapters({ email: createMailpitEmailSender() });
      return deliverDueCampaigns(dependencies);
    },
  },
] satisfies RegisteredJob[];

export const moduleDefinition = {
  name: 'communications',
  path: '/api/v1/communications',
  router: createCommunicationsRouter,
  jobs,
  permissions: [
    'communications.read',
    'communications.manage',
    'chat.read',
    'chat.send',
    'chat.moderate',
  ],
  notificationTypes: Object.keys(phase10NotificationTemplates),
  errorCodes: [],
  notificationTemplates: phase10NotificationTemplates,
  openapiRoutes: routes,
} satisfies ServerModule & {
  openapiRoutes: readonly unknown[];
  notificationTemplates: typeof phase10NotificationTemplates;
};
