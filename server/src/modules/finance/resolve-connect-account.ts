import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

import { PostgresConnectAccountRepository } from './repo.js';

/** Resolve Stripe's account metadata, then prove ownership inside withOrg. */
export async function resolveConnectAccountOrg(
  database: Kysely<DB>,
  actorAccountId: string,
  gateway: Pick<PaymentsGateway, 'retrieveAccount'>,
  stripeAccountId: string,
): Promise<string> {
  if (!stripeAccountId.startsWith('acct_'))
    throw new Error('Invalid connected Stripe account ID');
  const latest = await gateway.retrieveAccount(stripeAccountId);
  if (latest.id !== stripeAccountId)
    throw new Error('Stripe returned a different connected account');
  const orgId = z.uuid().parse(latest.orgId);
  const repository = new PostgresConnectAccountRepository(database, {
    orgId,
    actor: { accountId: actorAccountId },
  });
  const local = await repository.load(orgId);
  if (local?.stripeAccountId !== stripeAccountId)
    throw new Error(
      'Connected Stripe account metadata conflicts with organization',
    );
  return orgId;
}
