import express, { type Router } from 'express';

import type { StripeEventRepository, StripeEndpoint } from './dispatch.js';
import type { StripeSdkGateway } from './sdk.js';

export interface StripeWebhookDependencies {
  gateway: Pick<StripeSdkGateway, 'verifyWebhook'>;
  repository: StripeEventRepository;
  enqueue: (eventId: string) => Promise<void>;
  platformSecret: string;
  connectSecret: string;
}

/** Mount at /api/v1/webhooks; the raw parser must run before any JSON parser. */
export function createStripeWebhookRouter(
  deps: StripeWebhookDependencies,
): Router {
  const router = express.Router();
  const rawJson = express.raw({ type: 'application/json', limit: '2mb' });

  function endpoint(kind: StripeEndpoint, secret: string) {
    return async (
      request: express.Request,
      response: express.Response,
    ): Promise<void> => {
      const signature = request.header('stripe-signature');
      if (!signature || !Buffer.isBuffer(request.body)) {
        response.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid Stripe webhook',
          },
        });
        return;
      }
      let event;
      try {
        event = deps.gateway.verifyWebhook(request.body, signature, secret);
        if ((kind === 'connect') !== Boolean(event.account)) {
          throw new Error('Stripe event account does not match endpoint');
        }
      } catch {
        response.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid Stripe webhook',
          },
        });
        return;
      }
      try {
        const state = await deps.repository.store({
          id: event.id,
          endpoint: kind,
          event,
        });
        if (state !== 'processed') await deps.enqueue(event.id);
        response.status(200).json({ received: true });
      } catch {
        response.status(503).json({
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'Webhook temporarily unavailable',
          },
        });
      }
    };
  }

  router.post('/stripe', rawJson, endpoint('platform', deps.platformSecret));
  router.post(
    '/stripe-connect',
    rawJson,
    endpoint('connect', deps.connectSecret),
  );
  return router;
}
