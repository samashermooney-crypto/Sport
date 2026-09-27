import express from 'express';
import { sql } from 'kysely';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';
import {
  mutationOriginIsValid,
  orgActor,
  requireAnyRole,
  sendModuleError,
} from '../compliance/access';
import { systemWorkerActorId } from '../jobs/credentials-expiry';

import type { GuestDonationCheckoutPort } from './checkout';
import { PreviewGuestDonationCheckout } from './preview-checkout';
import {
  campaignBodySchema,
  campaignListSchema,
  campaignSchema,
  campaignStateSchema,
  donorStatementSchema,
  donationCheckoutSchema,
  fundraisingSettingsBodySchema,
  fundraisingSettingsSchema,
  guestDonationBodySchema,
  publicCampaignSchema,
} from './schema';
import {
  createCampaign,
  createGuestDonation,
  donorStatement,
  fundraisingSettings,
  listCampaigns,
  markDonationPaid,
  publicCampaign,
  saveFundraisingSettings,
  setCampaignStatus,
} from './service';

const managers = ['owner', 'admin', 'finance'] as const;
const uuid = (value: unknown) => z.uuid().parse(value);

export function createFundraisingRouter(
  dependencies: AuthDependencies & {
    donationCheckout?: GuestDonationCheckoutPort | undefined;
  },
): express.Router {
  const isProduction = process.env.NODE_ENV === 'production';
  const donationCheckout =
    dependencies.donationCheckout ??
    (isProduction
      ? undefined
      : new PreviewGuestDonationCheckout(dependencies.appUrl));
  const router = express.Router();
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
  router.use(express.json({ limit: '48kb' }));
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
        sendModuleError(response, error);
      }
    };

  router.get(
    '/public/orgs/:orgSlug/campaigns/:campaignSlug',
    endpoint(async (request, response) => {
      const campaign = await publicCampaign(
        dependencies.database,
        String(request.params.orgSlug),
        String(request.params.campaignSlug),
      );
      response.json(publicCampaignSchema.parse(campaign));
    }),
  );
  router.post(
    '/public/orgs/:orgSlug/campaigns/:campaignSlug/donations',
    endpoint(async (request, response) => {
      const body = guestDonationBodySchema.parse(request.body as unknown);
      if (!(await dependencies.captcha.verify(body.captchaToken, request.ip))) {
        response.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Donation verification failed',
          },
        });
        return;
      }
      if (!donationCheckout) {
        response.status(503).json({
          error: {
            code: 'CHECKOUT_UNAVAILABLE',
            message: 'Guest donation checkout is not connected',
          },
        });
        return;
      }
      const campaign = await publicCampaign(
        dependencies.database,
        String(request.params.orgSlug),
        String(request.params.campaignSlug),
      );
      const result = await createGuestDonation(
        dependencies.database,
        donationCheckout,
        {
          orgId: campaign.orgId,
          campaignId: campaign.id,
          donorName: body.donorName,
          donorEmail: body.donorEmail,
          amountCents: body.amountCents,
          anonymous: body.anonymous,
          dedication: body.dedication,
          idempotencyKey: uuid(request.get('Idempotency-Key')),
          appUrl: dependencies.appUrl,
        },
        dependencies.clock(),
      );
      response.status(201).json(
        donationCheckoutSchema.parse({
          donationId: result.donationId,
          checkoutUrl:
            'checkoutUrl' in result
              ? result.checkoutUrl
              : `${dependencies.appUrl}/donation-checkout/${result.checkoutSessionId}`,
          receiptNumber: result.receiptNumber,
          amountCents: result.amountCents,
        }),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/campaigns',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const body = campaignBodySchema.parse(request.body as unknown);
      const id = await createCampaign(
        dependencies.database,
        actor.context,
        body,
      );
      const campaigns = await listCampaigns(
        dependencies.database,
        actor.context,
      );
      response
        .status(201)
        .json(campaignSchema.parse(campaigns.find((item) => item.id === id)));
    }),
  );
  router.get(
    '/orgs/:orgId/campaigns',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      response.json(
        campaignListSchema.parse({
          campaigns: await listCampaigns(dependencies.database, actor.context),
        }),
      );
    }),
  );
  router.patch(
    '/orgs/:orgId/campaigns/:campaignId/status',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const status = await setCampaignStatus(
        dependencies.database,
        actor.context,
        uuid(request.params.campaignId),
        campaignStateSchema.parse(request.body as unknown),
        dependencies.clock(),
      );
      response.json(status);
    }),
  );
  router.get(
    '/orgs/:orgId/settings',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, ['owner', 'admin']);
      response.json(
        fundraisingSettingsSchema.parse(
          await fundraisingSettings(
            dependencies.database,
            actor.context,
            dependencies.encryption,
          ),
        ),
      );
    }),
  );
  router.put(
    '/orgs/:orgId/settings',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, ['owner', 'admin']);
      const result = await saveFundraisingSettings(
        dependencies.database,
        actor.context,
        dependencies.encryption,
        fundraisingSettingsBodySchema.parse(request.body as unknown),
      );
      response.json(fundraisingSettingsSchema.parse(result));
    }),
  );
  router.get(
    '/orgs/:orgId/donor-statements/:year',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const year = z.coerce
        .number()
        .int()
        .min(2000)
        .max(2100)
        .parse(request.params.year);
      response.json(
        donorStatementSchema.parse(
          await donorStatement(dependencies.database, actor.context, year),
        ),
      );
    }),
  );
  if (!isProduction) {
    router.get(
      '/preview-checkout/:orgId/:checkoutSessionId/complete',
      async (request, response) => {
        try {
          const orgId = uuid(request.params.orgId);
          const checkoutSessionId = z
            .string()
            .regex(/^preview_[0-9a-f-]{36}$/)
            .parse(request.params.checkoutSessionId);
          const donationId = uuid(request.query.donation);
          const context = {
            orgId,
            actor: { accountId: systemWorkerActorId },
          };
          await markDonationPaid(
            dependencies.database,
            context,
            dependencies.encryption,
            dependencies.email,
            {
              donationId,
              checkoutSessionId,
              providerPaymentId: `pi_preview_${checkoutSessionId}`,
            },
            dependencies.clock(),
          );
          const landing = await createWithOrg(dependencies.database)(
            context,
            async (trx) => {
              const result = await sql<{
                org_slug: string;
                campaign_slug: string;
              }>`
                SELECT organization.slug AS org_slug, campaign.slug AS campaign_slug
                FROM donations donation
                JOIN fundraising_campaigns campaign
                  ON campaign.org_id = donation.org_id
                 AND campaign.id = donation.campaign_id
                JOIN organizations organization ON organization.id = donation.org_id
                WHERE donation.org_id = ${orgId}::uuid AND donation.id = ${donationId}::uuid
              `.execute(trx);
              return result.rows[0];
            },
          );
          if (landing) {
            response.redirect(
              `/site/${encodeURIComponent(landing.org_slug)}/fundraisers/${encodeURIComponent(landing.campaign_slug)}?status=success`,
            );
          } else {
            response.redirect('/');
          }
        } catch {
          response.redirect('/');
        }
      },
    );
  }
  return router;
}
