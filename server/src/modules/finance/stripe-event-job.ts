import type { Kysely } from 'kysely';
import { z } from 'zod';

import { getDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import {
  StripeEventDispatcher,
  type StripeEventHandlers,
  type StripeEventRepository,
} from '../../integrations/stripe/dispatch.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { PostgresStripeEventRepository } from '../../integrations/stripe/repo.js';
import { createStripeGateway } from '../../integrations/stripe/sdk.js';
import { PostgresCheckoutHoldRepository } from '../checkout/capacity-repo.js';
import { CheckoutPaymentEventService } from '../checkout/payment-events.js';
import { CheckoutService } from '../checkout/service.js';
import { systemWorkerActorId } from '../jobs/credentials-expiry.js';

import { PostgresPaymentAttemptStore } from './attempt-repo.js';
import {
  billingSubscriptionHandlers,
  BillingSubscriptionEventService,
} from './billing-events.js';
import {
  billingInvoiceHandlers,
  BillingInvoiceEventService,
} from './billing-invoice-events.js';
import { PostgresBillingInvoices } from './billing-invoices.js';
import {
  connectAccountHandlers,
  ConnectAccountEventService,
} from './connect-events.js';
import { disputeHandlers, DisputeEventService } from './dispute-events.js';
import { PostgresDisputeLiabilityRepository } from './dispute-liability-repo.js';
import { PostgresDisputeRepository } from './dispute-repo.js';
import { PostgresFrozenChargeReader } from './frozen-charge-repo.js';
import { PostgresOrgBilling } from './org-billing.js';
import { PostgresPayerProfileRepository } from './payer-repo.js';
import { PostgresPaymentEventRepository } from './payment-event-repo.js';
import {
  PaymentIntentEventService,
  paymentIntentHandlers,
} from './payment-events.js';
import {
  PaymentMethodEventService,
  paymentMethodHandlers,
} from './payment-method-events.js';
import { PostgresSavedPaymentMethodRepository } from './payment-method-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';
import { PostgresPayoutMirror } from './payout-repo.js';
import { payoutHandlers, PayoutSyncService } from './payouts.js';
import { PostgresRefundEventRepository } from './refund-event-repo.js';
import { refundHandlers, RefundEventService } from './refund-events.js';
import { resolveConnectAccountOrg } from './resolve-connect-account.js';
import { CheckoutPaymentService } from './service.js';

const jobInput = z.strictObject({ eventId: z.string().startsWith('evt_') });

/** Every handled event is dispatched through its domain service with the system actor. */
export function financeStripeEventHandlers(
  database: Kysely<DB>,
  gateway: PaymentsGateway,
): StripeEventHandlers {
  const actor = systemWorkerActorId;
  const resolveOrg = (accountId: string) =>
    resolveConnectAccountOrg(database, actor, gateway, accountId);
  const syncSubscription = async (
    orgId: string,
    latest: Awaited<ReturnType<PaymentsGateway['retrieveBillingSubscription']>>,
  ): Promise<void> => {
    await new PostgresOrgBilling(database, {
      orgId,
      actor: { accountId: actor },
    }).syncLatest(latest);
  };
  const handlers: StripeEventHandlers = {
    ...paymentIntentHandlers(
      new PaymentIntentEventService(
        new PostgresPaymentEventRepository(database, actor),
        gateway,
        {
          applyLatest: (input) => {
            const context = {
              orgId: input.orgId,
              actor: { accountId: actor },
            };
            const capacity = new PostgresCheckoutHoldRepository(
              database,
              context,
            );
            const payment = new CheckoutPaymentService(
              new PostgresFrozenChargeReader(database, context),
              new PostgresPaymentAttemptStore(database, context),
              gateway,
              new PostgresPaymentRecordStore(database, context),
            );
            const checkout = new CheckoutService(capacity, payment, gateway);
            return new CheckoutPaymentEventService(
              database,
              actor,
              capacity,
              checkout,
            ).applyLatest(input);
          },
        },
      ),
    ),
    ...refundHandlers(
      new RefundEventService(
        new PostgresRefundEventRepository(database, actor),
        gateway,
      ),
    ),
    ...disputeHandlers(
      new DisputeEventService(
        gateway,
        new PostgresDisputeRepository(database, actor),
        new PostgresDisputeLiabilityRepository(database, actor),
      ),
      gateway,
      resolveOrg,
    ),
    ...paymentMethodHandlers(
      new PaymentMethodEventService(
        new PostgresPayerProfileRepository(database),
        new PostgresSavedPaymentMethodRepository(database),
        gateway,
      ),
    ),
    ...connectAccountHandlers(
      new ConnectAccountEventService(database, actor, gateway),
    ),
    ...payoutHandlers(
      new PayoutSyncService(gateway, new PostgresPayoutMirror(database, actor)),
      resolveOrg,
    ),
    ...billingSubscriptionHandlers(
      new BillingSubscriptionEventService(gateway, syncSubscription),
    ),
    ...billingInvoiceHandlers(
      new BillingInvoiceEventService(
        gateway,
        syncSubscription,
        async (orgId, latest) => {
          await new PostgresBillingInvoices(database, {
            orgId,
            actor: { accountId: actor },
          }).applyLatest(latest);
        },
      ),
    ),
  };
  const connectTypes = new Set<string>([
    'account.updated',
    'payout.created',
    'payout.paid',
    'payout.failed',
  ]);
  for (const [type, handler] of Object.entries(handlers)) {
    const connect = connectTypes.has(type);
    handlers[type as keyof StripeEventHandlers] = async (event) => {
      if (Boolean(event.account) !== connect)
        throw new Error('Stripe event arrived on the wrong endpoint');
      await handler(event);
    };
  }
  return handlers;
}

export interface FinanceStripeEventJobDependencies {
  database: Kysely<DB>;
  gateway: PaymentsGateway;
  repository: StripeEventRepository;
}

export async function dispatchFinanceStripeEvent(
  data: unknown,
  dependencies: FinanceStripeEventJobDependencies,
): Promise<'processed' | 'already_claimed'> {
  const { eventId } = jobInput.parse(data);
  return new StripeEventDispatcher(
    dependencies.repository,
    financeStripeEventHandlers(dependencies.database, dependencies.gateway),
  ).dispatch(eventId);
}

export function runFinanceStripeEventJob(data: unknown) {
  const database = getDatabase();
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is required');
  return dispatchFinanceStripeEvent(data, {
    database,
    gateway: createStripeGateway(secret),
    repository: new PostgresStripeEventRepository(database),
  });
}

export async function replayStoredStripeEvents(
  repository: Pick<PostgresStripeEventRepository, 'pendingIds'>,
  dispatch: (eventId: string) => Promise<'processed' | 'already_claimed'>,
): Promise<{ processed: number }> {
  const ids = await repository.pendingIds(100);
  let processed = 0;
  const errors: unknown[] = [];
  for (const id of ids) {
    try {
      if ((await dispatch(id)) === 'processed') processed += 1;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Stripe event replay failed');
  return { processed };
}

export function runFinanceStripeReplayJob(): Promise<{ processed: number }> {
  const database = getDatabase();
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is required');
  const gateway = createStripeGateway(secret);
  const repository = new PostgresStripeEventRepository(database);
  const dispatcher = new StripeEventDispatcher(
    repository,
    financeStripeEventHandlers(database, gateway),
  );
  return replayStoredStripeEvents(repository, (id) => dispatcher.dispatch(id));
}
