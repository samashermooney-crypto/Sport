import type { Kysely } from 'kysely';

import { getDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { createStripeGateway } from '../../integrations/stripe/sdk.js';
import { systemWorkerActorId } from '../jobs/credentials-expiry.js';

import { PostgresInstallmentChargeRepository } from './installment-charge-repo.js';
import { InstallmentDunningService } from './installment-dunning.js';

export interface InstallmentChargeJobDependencies {
  database: Kysely<DB>;
  gateway: PaymentsGateway;
  now: () => Date;
  organizationIds?: readonly string[];
}

/** Scan every org despite individual failures, but fail the job for alerting. */
export async function scanDueInstallments(
  organizationIds: readonly string[],
  now: string,
  chargeOne: InstallmentDunningService['chargeOne'],
): Promise<{ created: number }> {
  let created = 0;
  const errors: unknown[] = [];
  for (const orgId of organizationIds) {
    try {
      for (let index = 0; index < 100; index += 1) {
        const result = await chargeOne(orgId, now);
        if (result.kind === 'none') break;
        created += 1;
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Installment charge job failed');
  return { created };
}

/** Bounded per-org scan; each attempt has its own durable pre-Stripe claim. */
async function chargeDueInstallments(
  dependencies: InstallmentChargeJobDependencies,
): Promise<{ created: number }> {
  const organizationIds =
    dependencies.organizationIds ??
    (
      await dependencies.database
        .selectFrom('organizations')
        .select('id')
        .where('status', '=', 'active')
        .orderBy('id')
        .execute()
    ).map(({ id }) => id);
  const service = new InstallmentDunningService(
    new PostgresInstallmentChargeRepository(
      dependencies.database,
      systemWorkerActorId,
    ),
    dependencies.gateway,
  );
  return scanDueInstallments(
    organizationIds,
    dependencies.now().toISOString(),
    (orgId, now) => service.chargeOne(orgId, now),
  );
}

export function runInstallmentChargeJob(): Promise<{ created: number }> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is required');
  return chargeDueInstallments({
    database: getDatabase(),
    gateway: createStripeGateway(secret),
    now: () => new Date(),
  });
}
