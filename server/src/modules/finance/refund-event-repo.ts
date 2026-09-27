import { Temporal } from '@js-temporal/polyfill';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { GatewayRefund } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';
import { createNotification } from '../notifications/service.js';

import { activeFinanceNotificationRecipients } from './finance-notification-recipients.js';
import { recomputeInvoiceStatus } from './invoice-repo.js';
import type { RefundEventRepository } from './refund-events.js';

type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

function status(value: string): RefundStatus {
  if (
    value === 'pending' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'canceled'
  )
    return value;
  throw new Error(`Unsupported Stripe refund status: ${value}`);
}

export class PostgresRefundEventRepository implements RefundEventRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly actorAccountId: string,
    private readonly now: () => Temporal.Instant = () => Temporal.Now.instant(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async applyLatest(input: {
    orgId: string;
    refund: GatewayRefund;
  }): Promise<'applied' | 'unchanged'> {
    const target = status(input.refund.status);
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: this.actorAccountId },
    };
    return this.withOrg(context, async (trx) => {
      const refund = await trx
        .selectFrom('refunds')
        .select(['id', 'payment_id', 'status', 'amount_cents'])
        .where('org_id', '=', input.orgId)
        .where('stripe_refund_id', '=', input.refund.id)
        .forUpdate()
        .executeTakeFirst();
      if (!refund) throw new Error('Stripe refund has no local record');
      if (refund.amount_cents !== input.refund.amountCents)
        throw new Error('Stripe refund amount differs from recorded refund');
      const payment = await trx
        .selectFrom('payments')
        .select(['stripe_payment_intent_id', 'account_id'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', refund.payment_id)
        .executeTakeFirstOrThrow();
      if (
        input.refund.paymentIntentId &&
        payment.stripe_payment_intent_id !== input.refund.paymentIntentId
      )
        throw new Error(
          'Stripe refund PaymentIntent differs from recorded payment',
        );
      if (refund.status === 'succeeded' && target !== 'succeeded')
        throw new Error('Successful refund cannot regress');
      if (
        (refund.status === 'failed' || refund.status === 'canceled') &&
        target !== refund.status
      )
        throw new Error('Terminal refund cannot change status');
      if (refund.status === target) return 'unchanged';
      const allocations = await sql<{ invoice_id: string; total: number }>`
        SELECT line.invoice_id, sum(allocation.amount_cents)::bigint AS total
        FROM refund_allocations allocation
        JOIN invoice_lines line ON line.org_id = allocation.org_id
          AND line.id = allocation.invoice_line_id
        WHERE allocation.org_id = ${input.orgId}::uuid
          AND allocation.refund_id = ${refund.id}::uuid
        GROUP BY line.invoice_id
      `.execute(trx);
      if (
        allocations.rows.reduce((sum, item) => sum + item.total, 0) !==
        refund.amount_cents
      )
        throw new Error('Refund allocations do not reconcile');
      await sql`
        UPDATE refunds SET status = ${target}, version = version + 1,
          succeeded_at = CASE WHEN ${target} = 'succeeded'
            THEN ${new Date(this.now().toString())}::timestamptz
            ELSE succeeded_at END
        WHERE org_id = ${input.orgId}::uuid AND id = ${refund.id}::uuid
      `.execute(trx);
      if (target === 'succeeded') {
        const org = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', input.orgId)
          .executeTakeFirstOrThrow();
        const todayLocal = this.now()
          .toZonedDateTimeISO(org.timezone)
          .toPlainDate()
          .toString();
        for (const allocation of allocations.rows) {
          await trx
            .updateTable('invoices')
            .set({
              refunded_cents: sql`refunded_cents + ${allocation.total}`,
              version: sql`version + 1`,
            })
            .where('org_id', '=', input.orgId)
            .where('id', '=', allocation.invoice_id)
            .execute();
          await recomputeInvoiceStatus(
            trx,
            input.orgId,
            allocation.invoice_id,
            todayLocal,
          );
        }
        const staff = await activeFinanceNotificationRecipients(
          trx,
          input.orgId,
        );
        const recipients = new Set([
          ...(payment.account_id ? [payment.account_id] : []),
          ...staff,
        ]);
        if (!payment.account_id)
          throw new Error('Settled refund payment lacks a payer account');
        for (const accountId of recipients) {
          await createNotification(trx, context, {
            accountId,
            type: 'refund.issued',
            payload: { resourceType: 'refund', resourceId: refund.id },
          });
        }
      }
      await appendAuditEvent(trx, context, {
        action: `refund.${target}`,
        entityType: 'refund',
        entityId: refund.id,
        changes: {
          status: { tier: 'internal', before: refund.status, after: target },
        },
      });
      return 'applied';
    });
  }
}
