import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { withOrgInTransaction } from '../../db/withOrg.js';
import type { GatewayPaymentMethod } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';

import type { SavedPaymentMethodRepository } from './payer-methods.js';

/** Global payer methods, with org-scoped revocation for any linked autopay. */
export class PostgresSavedPaymentMethodRepository implements SavedPaymentMethodRepository {
  constructor(private readonly database: Kysely<DB>) {}

  async sync(
    accountId: string,
    methods: readonly GatewayPaymentMethod[],
  ): Promise<void> {
    if (new Set(methods.map((method) => method.id)).size !== methods.length)
      throw new Error('Stripe returned duplicate payment method IDs');
    await this.database.transaction().execute(async (trx) => {
      for (const method of methods) {
        const existing = await trx
          .selectFrom('payment_methods')
          .select(['id', 'account_id'])
          .where('stripe_payment_method_id', '=', method.id)
          .forUpdate()
          .executeTakeFirst();
        if (existing && existing.account_id !== accountId)
          throw new Error('Stripe method belongs to a different payer');
        if (existing) {
          await trx
            .updateTable('payment_methods')
            .set({
              type: method.type,
              brand: method.brand,
              last4: method.last4,
              exp_month: method.expMonth,
              exp_year: method.expYear,
              bank_name: method.bankName,
              status: 'active',
              version: sql`version + 1`,
            })
            .where('id', '=', existing.id)
            .execute();
        } else {
          await trx
            .insertInto('payment_methods')
            .values({
              id: newId(),
              account_id: accountId,
              stripe_payment_method_id: method.id,
              type: method.type,
              brand: method.brand,
              last4: method.last4,
              exp_month: method.expMonth,
              exp_year: method.expYear,
              bank_name: method.bankName,
            })
            .execute();
        }
      }
    });
  }

  async setDefault(accountId: string, paymentMethodId: string): Promise<void> {
    await this.database.transaction().execute(async (trx) => {
      const method = await trx
        .selectFrom('payment_methods')
        .select(['id', 'status'])
        .where('account_id', '=', accountId)
        .where('stripe_payment_method_id', '=', paymentMethodId)
        .forUpdate()
        .executeTakeFirst();
      if (!method || method.status !== 'active')
        throw new Error('Active payment method is unavailable');
      await trx
        .updateTable('payment_methods')
        .set({ is_default: false, version: sql`version + 1` })
        .where('account_id', '=', accountId)
        .where('is_default', '=', true)
        .execute();
      await trx
        .updateTable('payment_methods')
        .set({ is_default: true, version: sql`version + 1` })
        .where('id', '=', method.id)
        .execute();
    });
  }

  async markDetached(
    accountId: string,
    paymentMethodId: string,
  ): Promise<void> {
    await this.database.transaction().execute(async (trx) => {
      const method = await trx
        .selectFrom('payment_methods')
        .select(['id', 'status'])
        .where('account_id', '=', accountId)
        .where('stripe_payment_method_id', '=', paymentMethodId)
        .forUpdate()
        .executeTakeFirst();
      if (!method)
        throw new Error('Payment method is unavailable for this payer');
      if (method.status !== 'detached') {
        await trx
          .updateTable('payment_methods')
          .set({
            status: 'detached',
            is_default: false,
            version: sql`version + 1`,
          })
          .where('id', '=', method.id)
          .execute();
      }
      const organizations = await trx
        .selectFrom('organizations')
        .select('id')
        .execute();
      for (const org of organizations) {
        const context = { orgId: org.id, actor: { accountId } };
        await withOrgInTransaction(trx, context, async (scoped) => {
          const revoked = await scoped
            .updateTable('autopay_authorizations')
            .set({ revoked_at: new Date() })
            .where('org_id', '=', org.id)
            .where('account_id', '=', accountId)
            .where('payment_method_id', '=', method.id)
            .where('revoked_at', 'is', null)
            .returning('id')
            .execute();
          const stopped = await scoped
            .updateTable('installments')
            .set({
              autopay: false,
              payment_method_id: null,
              next_attempt_at: null,
              version: sql`version + 1`,
            })
            .where('org_id', '=', org.id)
            .where('payment_method_id', '=', method.id)
            .where('autopay', '=', true)
            .where('status', 'in', ['scheduled', 'failed'])
            .returning('id')
            .execute();
          if (revoked.length || stopped.length) {
            await appendAuditEvent(scoped, context, {
              action: 'payment_method.detached',
              entityType: 'payment_method',
              entityId: method.id,
              changes: {
                authorizationsRevoked: {
                  tier: 'internal',
                  after: revoked.length,
                },
                installmentsStopped: {
                  tier: 'internal',
                  after: stopped.length,
                },
              },
            });
          }
        });
      }
    });
  }
}
