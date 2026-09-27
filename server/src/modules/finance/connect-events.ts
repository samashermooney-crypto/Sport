import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import type { StripeEventHandlers } from '../../integrations/stripe/dispatch.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type { StripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

import { PostgresConnectAccountRepository } from './repo.js';
import { resolveConnectAccountOrg } from './resolve-connect-account.js';

const accountObject = z.object({
  id: z.string().startsWith('acct_'),
  object: z.literal('account'),
});

/** Connect account webhooks are hints; only a fresh Stripe read changes state. */
export class ConnectAccountEventService {
  constructor(
    private readonly database: Kysely<DB>,
    private readonly actorAccountId: string,
    private readonly gateway: Pick<PaymentsGateway, 'retrieveAccount'>,
  ) {}

  async handle(event: StripeWebhookEvent): Promise<void> {
    if (event.type !== 'account.updated')
      throw new Error('Expected a Connect account update');
    const object = accountObject.parse(event.data.object);
    if (event.account !== object.id)
      throw new Error('Connect event account does not match its payload');
    const orgId = await resolveConnectAccountOrg(
      this.database,
      this.actorAccountId,
      this.gateway,
      object.id,
    );
    const latest = await this.gateway.retrieveAccount(object.id);
    if (latest.id !== object.id || latest.orgId !== orgId)
      throw new Error('Connected Stripe account changed ownership');
    await new PostgresConnectAccountRepository(this.database, {
      orgId,
      actor: { accountId: this.actorAccountId },
    }).update({
      orgId,
      stripeAccountId: latest.id,
      chargesEnabled: latest.chargesEnabled,
      payoutsEnabled: latest.payoutsEnabled,
      detailsSubmitted: latest.detailsSubmitted,
      requirementsDue: latest.requirements.currentlyDue,
      disabledReason: latest.requirements.disabledReason,
    });
  }
}

export function connectAccountHandlers(
  service: ConnectAccountEventService,
): StripeEventHandlers {
  return { 'account.updated': (event) => service.handle(event) };
}
