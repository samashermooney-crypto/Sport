import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract.js';

import { checkoutQuoteSchema } from './checkout-quote.js';
import {
  registrationCartSchema,
  startedCheckoutSchema,
} from './checkout-start.js';
import {
  approveBodySchema,
  cancelBodySchema,
  myRegistrationListSchema,
  registrationCancelResponseSchema,
  registrationRefundPreviewSchema,
  registrationTransferResponseSchema,
  staffRegistrationListSchema,
  transferBodySchema,
  waitlistEntrySchema,
  waitlistJoinBodySchema,
} from './lifecycle.js';
import { runRegistrationNoticeJob } from './notice-job.js';
import { checkoutPolicyReviewSchema } from './policy-acceptance.js';
import {
  registrationPaceSchema,
  registrationReportSchema,
  uniformSizeReportSchema,
} from './reports.js';
import {
  checkoutRequirementsSchema,
  requirementsDiscoverySchema,
} from './requirements.js';
import {
  createRegistrationRouter,
  registrationCatalogSchema,
  registrationParticipantsSchema,
  checkoutViewSchema,
} from './routes.js';
import {
  acceptTeamEntryInviteSchema,
  createTeamEntrySchema,
  inviteTeamPlayersSchema,
  teamEntryDecisionSchema,
  teamEntryInviteListSchema,
  teamEntryInvitePreviewSchema,
  teamEntryListSchema,
  teamEntryOptionsSchema,
  teamEntrySchema,
} from './team-entries.js';

export const moduleDefinition = {
  name: 'registration',
  path: '/api/v1/registration',
  router: createRegistrationRouter,
  jobs: [
    {
      name: 'registration.notice',
      run: runRegistrationNoticeJob,
      cron: '* * * * *',
    },
  ],
  permissions: [],
  notificationTypes: [],
  errorCodes: [
    'CAPACITY_FULL',
    'INELIGIBLE',
    'ALREADY_REGISTERED',
    'REQUIREMENTS_PENDING',
    'REQUIREMENTS_STALE',
    'FORM_INCOMPLETE',
    'WAIVER_REQUIRED',
    'CANCELLATION_ALREADY_RECORDED',
    'DECISION_ALREADY_RECORDED',
    'OFFER_UNAVAILABLE',
    'WAITLIST_CLOSED',
    'WAITLIST_NOT_FULL',
    'NOT_TRANSFERABLE',
    'DESTINATION_UNAVAILABLE',
    'IDEMPOTENCY_CONFLICT',
    'TEAM_ENTRY_UNAVAILABLE',
  ],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/catalog',
      summary: 'List public registration offerings',
      response: registrationCatalogSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/participants',
      summary: 'List directly linked family participants for a cart',
      response: registrationParticipantsSchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/checkouts',
      summary: 'Start an eligibility-checked family checkout',
      body: registrationCartSchema,
      response: startedCheckoutSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/checkouts/{checkoutId}',
      summary: 'Resume the payer-owned checkout',
      response: checkoutViewSchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/checkouts/{checkoutId}/quote',
      summary: 'Freeze pricing and issue the checkout invoice',
      response: checkoutQuoteSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/checkouts/{checkoutId}/requirements',
      summary: 'Discover forms, waivers and checkout choices',
      response: requirementsDiscoverySchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/checkouts/{checkoutId}/requirements',
      summary: 'Submit validated family registration requirements',
      body: checkoutRequirementsSchema,
      response: startedCheckoutSchema.pick({ checkoutId: true }).extend({
        requirementsSubmitted: z.literal(true),
      }),
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/checkouts/{checkoutId}/refund-terms',
      summary: 'Review the exact refund terms for this checkout',
      response: checkoutPolicyReviewSchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/checkouts/{checkoutId}/refund-terms/accept',
      summary: 'Record payer acceptance of the current refund terms',
      body: checkoutPolicyReviewSchema.pick({ termsHash: true }),
      response: checkoutPolicyReviewSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/me/registrations',
      summary: 'List registrations for linked family participants',
      response: myRegistrationListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/registrations',
      summary: 'List registrations in the active registrar role scope',
      response: staffRegistrationListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/reports/registrations',
      summary:
        'Filter registration reports by program, division, offering and status',
      response: registrationReportSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/reports/registrations.csv',
      summary: 'Export the scoped registration report as CSV',
      response: z.string(),
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/reports/uniform-sizes',
      summary: 'Report selected add-on sizes by program, division and team',
      response: uniformSizeReportSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/reports/pace/{programId}',
      summary: 'Compare registration pace with the copied prior-season program',
      response: registrationPaceSchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/me/registrations/{registrationId}/cancel',
      summary: 'Cancel or withdraw a family registration',
      body: cancelBodySchema,
      response: registrationCancelResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/me/registrations/{registrationId}/cancellation-preview',
      summary: 'Preview frozen refund terms before family cancellation',
      response: registrationRefundPreviewSchema.nullable(),
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/registrations/{registrationId}/cancel',
      summary: 'Cancel a registration as scoped staff',
      body: cancelBodySchema,
      response: registrationCancelResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/registrations/{registrationId}/cancellation-preview',
      summary: 'Preview frozen refund terms before staff cancellation',
      response: registrationRefundPreviewSchema.nullable(),
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/registrations/{registrationId}/approval',
      summary: 'Approve or decline a registration',
      body: approveBodySchema.extend({
        decision: z.enum(['approved', 'declined']),
      }),
      response: z.strictObject({
        status: z.string(),
        paymentDueAt: z.iso.datetime().nullable(),
      }),
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/registrations/{registrationId}/transfer',
      summary: 'Transfer a registration with explicit financial treatment',
      body: transferBodySchema,
      response: registrationTransferResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/me/team-entries',
      summary: 'List team entries owned by the authenticated captain',
      response: teamEntryListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/team-entry-options',
      summary: 'List open zero-fee team offerings and verified adult captains',
      response: teamEntryOptionsSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/team-entries',
      summary: 'List team entries in the registrar role scope',
      response: teamEntryListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/team-entries',
      summary: 'Register an external adult team as its verified captain',
      body: createTeamEntrySchema,
      response: teamEntrySchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/team-entries/{entryId}/invites',
      summary: 'List captain and staff-visible player invitations',
      response: teamEntryInviteListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/team-entries/{entryId}/invites',
      summary: 'Invite players by verified account email',
      body: inviteTeamPlayersSchema,
      response: z.strictObject({
        invites: z.array(
          z.strictObject({
            id: z.uuid(),
            email: z.email(),
            expiresAt: z.iso.datetime(),
            inviteUrl: z.url(),
          }),
        ),
      }),
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/team-entries/{entryId}/approval',
      summary: 'Approve or decline an external team entry',
      body: z.strictObject({
        decision: z.enum(['approved', 'declined']),
        note: z.string().trim().max(400).optional(),
      }),
      response: teamEntryDecisionSchema,
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/team-entry-invites/{token}',
      summary: 'Read a team invitation for the authenticated invited player',
      response: teamEntryInvitePreviewSchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/team-entry-invites/{token}/accept',
      summary: 'Accept an invitation and open the normal player checkout',
      body: acceptTeamEntryInviteSchema,
      response: z.strictObject({ checkoutId: z.uuid() }),
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/me/waitlist',
      summary: 'List active family waitlist entries',
      response: z.strictObject({ entries: z.array(waitlistEntrySchema) }),
    },
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/waitlist',
      summary:
        'List offering waitlist entries in the active registrar role scope',
      response: z.strictObject({ entries: z.array(waitlistEntrySchema) }),
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/me/waitlist',
      summary: 'Join an offering waitlist',
      body: waitlistJoinBodySchema,
      response: waitlistEntrySchema,
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/me/waitlist/{entryId}/accept',
      summary: 'Accept a family waitlist offer',
      response: z.strictObject({ checkoutId: z.uuid() }),
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/me/waitlist/{entryId}/decline',
      summary: 'Decline a family waitlist offer',
      body: z.strictObject({}),
      response: z.strictObject({ ok: z.literal(true) }),
    },
    {
      method: 'post',
      path: '/api/v1/registration/orgs/{orgId}/waitlist/offers',
      summary: 'Offer the next or selected waitlist entry as scoped staff',
      body: z.strictObject({
        offeringId: z.uuid(),
        entryId: z.uuid().optional(),
      }),
      response: z.union([
        z.strictObject({ entryId: z.uuid(), expiresAt: z.iso.datetime() }),
        z.literal('full'),
        z.literal('empty'),
      ]),
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
