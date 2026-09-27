import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract.js';

import { checkoutQuoteSchema } from './checkout-quote.js';
import {
  registrationCartSchema,
  startedCheckoutSchema,
} from './checkout-start.js';
import { checkoutPolicyReviewSchema } from './policy-acceptance.js';
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

export const moduleDefinition = {
  name: 'registration',
  path: '/api/v1/registration',
  router: createRegistrationRouter,
  jobs: [],
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
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
