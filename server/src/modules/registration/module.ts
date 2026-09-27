import type { ServerModule } from '../../lib/module-contract.js';

import {
  registrationCartSchema,
  startedCheckoutSchema,
} from './checkout-start.js';
import {
  createRegistrationRouter,
  registrationCatalogSchema,
  checkoutViewSchema,
} from './routes.js';

export const moduleDefinition = {
  name: 'registration',
  path: '/api/v1/registration',
  router: createRegistrationRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: ['CAPACITY_FULL', 'INELIGIBLE', 'ALREADY_REGISTERED'],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/registration/orgs/{orgId}/catalog',
      summary: 'List public registration offerings',
      response: registrationCatalogSchema,
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
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
