import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import { refundTermsSchema } from '../finance/refund-terms.js';

import { RegistrationCheckoutError } from './checkout-start.js';

export const checkoutPolicyReviewSchema = z.strictObject({
  terms: refundTermsSchema,
  termsHash: z.string().regex(/^[0-9a-f]{64}$/),
  accepted: z.boolean(),
});

export function refundTermsHash(
  terms: z.output<typeof refundTermsSchema>,
): string {
  return createHash('sha256').update(JSON.stringify(terms)).digest('hex');
}

/** Captures the exact refund policy a payer saw before issuing a checkout invoice. */
export class PostgresCheckoutPolicyAcceptance {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async review(
    checkoutId: string,
  ): Promise<z.output<typeof checkoutPolicyReviewSchema>> {
    z.uuid().parse(checkoutId);
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select(['account_id', 'status', 'expires_at'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', checkoutId)
        .executeTakeFirst();
      if (
        !checkout ||
        checkout.account_id !== this.context.actor.accountId ||
        !['open', 'awaiting_payment'].includes(checkout.status) ||
        checkout.expires_at <= new Date()
      )
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Checkout is unavailable',
        );
      const org = await trx
        .selectFrom('organizations')
        .select('settings')
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      const settings = z
        .looseObject({ refundTerms: refundTermsSchema })
        .safeParse(org.settings);
      if (!settings.success)
        throw new RegistrationCheckoutError(
          409,
          'REFUND_POLICY_REQUIRED',
          'The organization must publish refund terms',
        );
      const termsHash = refundTermsHash(settings.data.refundTerms);
      const accepted = await sql<{ exists: boolean }>`
        SELECT EXISTS (SELECT 1 FROM checkout_policy_acceptances
          WHERE org_id = ${this.context.orgId}::uuid AND checkout_id = ${checkoutId}::uuid
            AND account_id = ${this.context.actor.accountId}::uuid
            AND terms_hash = ${termsHash}) AS exists
      `.execute(trx);
      return checkoutPolicyReviewSchema.parse({
        terms: settings.data.refundTerms,
        termsHash,
        accepted: accepted.rows[0]?.exists ?? false,
      });
    });
  }

  async accept(
    checkoutId: string,
    termsHash: string,
    userAgent: string | null,
  ): Promise<z.output<typeof checkoutPolicyReviewSchema>> {
    z.uuid().parse(checkoutId);
    z.string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(termsHash);
    if (userAgent && userAgent.length > 500)
      throw new RegistrationCheckoutError(
        400,
        'VALIDATION_ERROR',
        'User agent is too long',
      );
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select(['account_id', 'status', 'expires_at'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !checkout ||
        checkout.account_id !== this.context.actor.accountId ||
        !['open', 'awaiting_payment'].includes(checkout.status) ||
        checkout.expires_at <= new Date()
      )
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Checkout is unavailable',
        );
      const org = await trx
        .selectFrom('organizations')
        .select('settings')
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      const settings = z
        .looseObject({ refundTerms: refundTermsSchema })
        .safeParse(org.settings);
      if (!settings.success)
        throw new RegistrationCheckoutError(
          409,
          'REFUND_POLICY_REQUIRED',
          'The organization must publish refund terms',
        );
      const actualHash = refundTermsHash(settings.data.refundTerms);
      if (actualHash !== termsHash)
        throw new RegistrationCheckoutError(
          409,
          'REFUND_POLICY_CHANGED',
          'Refund terms changed; review them again',
        );
      const inserted = await sql<{ id: string }>`
        INSERT INTO checkout_policy_acceptances
          (id, org_id, checkout_id, account_id, terms_hash, terms_snapshot, user_agent)
        VALUES (${newId()}::uuid, ${this.context.orgId}::uuid, ${checkoutId}::uuid,
          ${this.context.actor.accountId}::uuid, ${actualHash},
          ${JSON.stringify(settings.data.refundTerms)}::jsonb, ${userAgent})
        ON CONFLICT (org_id, checkout_id, terms_hash) DO NOTHING RETURNING id
      `.execute(trx);
      if (inserted.rows[0])
        await appendAuditEvent(trx, this.context, {
          action: 'checkout.refund_terms_accepted',
          entityType: 'checkout',
          entityId: checkoutId,
          changes: { termsHash: { tier: 'internal', after: actualHash } },
        });
      return checkoutPolicyReviewSchema.parse({
        terms: settings.data.refundTerms,
        termsHash: actualHash,
        accepted: true,
      });
    });
  }
}
