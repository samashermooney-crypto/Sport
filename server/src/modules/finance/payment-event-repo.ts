import { Temporal } from '@js-temporal/polyfill';
import { nextInstallmentAttempt } from '@shared/algorithms/dunning-schedule';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { GatewayPaymentIntent } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';
import { createNotification } from '../notifications/service.js';

import { activeFinanceNotificationRecipients } from './finance-notification-recipients.js';
import { recomputeInvoiceStatus } from './invoice-repo.js';
import { applyFinalInstallmentLateFee } from './late-fees.js';
import { enqueueFinanceNotice } from './money-notices.js';
import type {
  PaymentEventRepository,
  PaymentEventResult,
} from './payment-events.js';

type StoredStatus =
  'requires_action' | 'processing' | 'succeeded' | 'failed' | 'canceled';

function storedStatus(stripeStatus: string): StoredStatus {
  switch (stripeStatus) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'requires_payment_method':
      return 'failed';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_capture':
      return 'requires_action';
    default:
      throw new Error(
        `Unsupported Stripe PaymentIntent status: ${stripeStatus}`,
      );
  }
}

/** Applies the current Stripe intent state while holding the payment and invoice rows. */
export class PostgresPaymentEventRepository implements PaymentEventRepository {
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
    paymentIntentId: string;
    latest: GatewayPaymentIntent;
  }): Promise<PaymentEventResult> {
    if (input.latest.id !== input.paymentIntentId)
      throw new Error('Stripe PaymentIntent ID mismatch');
    const target = storedStatus(input.latest.status);
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: this.actorAccountId },
    };
    return this.withOrg(context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select([
          'id',
          'account_id',
          'amount_cents',
          'status',
          'method',
          'stripe_charge_id',
          'failure_code',
          'failure_message',
        ])
        .select(
          sql<Date | null>`processing_started_at`.as('processing_started_at'),
        )
        .where('org_id', '=', input.orgId)
        .where('stripe_payment_intent_id', '=', input.paymentIntentId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment)
        throw new Error('Stripe PaymentIntent has no payment record');
      if (payment.amount_cents !== input.latest.amountCents)
        throw new Error(
          'Stripe PaymentIntent amount differs from recorded payment',
        );
      if (payment.status === 'succeeded' && target !== 'succeeded')
        throw new Error('A successful Stripe payment cannot regress');
      if (payment.status === 'canceled' && target !== 'canceled')
        throw new Error('A canceled Stripe payment cannot change status');
      const allocations = await trx
        .selectFrom('payment_allocations')
        .select(['invoice_id', 'installment_id', 'amount_cents'])
        .where('org_id', '=', input.orgId)
        .where('payment_id', '=', payment.id)
        .execute();
      if (
        allocations.length !== 1 ||
        allocations[0]?.amount_cents !== payment.amount_cents
      ) {
        throw new Error('Payment allocation does not reconcile');
      }
      const allocation = allocations[0];
      const method = input.latest.method ?? payment.method;
      if (target === 'succeeded' && method === 'unknown')
        throw new Error('Successful Stripe payment method is unknown');
      const chargeId = input.latest.latestChargeId ?? payment.stripe_charge_id;
      const failureCode =
        target === 'failed'
          ? (input.latest.failureCode ?? 'unknown')
          : target === 'canceled'
            ? 'canceled'
            : null;
      const failureMessage =
        target === 'failed' ? (input.latest.failureMessage ?? null) : null;
      if (
        target === payment.status &&
        method === payment.method &&
        chargeId === payment.stripe_charge_id &&
        failureCode === payment.failure_code &&
        failureMessage === payment.failure_message
      )
        return 'unchanged';

      const org = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', input.orgId)
        .executeTakeFirstOrThrow();
      const todayLocal = this.now()
        .toZonedDateTimeISO(org.timezone)
        .toPlainDate()
        .toString();
      const firstSuccess =
        target === 'succeeded' && payment.status !== 'succeeded';
      const firstProcessing =
        target === 'processing' && payment.processing_started_at === null;
      await trx
        .updateTable('payments')
        .set({
          status: target,
          method,
          stripe_charge_id: chargeId,
          failure_code: failureCode,
          failure_message: failureMessage,
          succeeded_at: firstSuccess
            ? new Date(this.now().epochMilliseconds)
            : undefined,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', payment.id)
        .execute();
      if (firstProcessing) {
        await sql`
          UPDATE payments SET processing_started_at = ${new Date(this.now().epochMilliseconds)}
          WHERE org_id = ${input.orgId}::uuid AND id = ${payment.id}::uuid
        `.execute(trx);
      }
      if (firstSuccess) {
        await trx
          .updateTable('invoices')
          .set({
            paid_cents: sql`paid_cents + ${allocation.amount_cents}`,
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('id', '=', allocation.invoice_id)
          .execute();
        if (allocation.installment_id) {
          await trx
            .updateTable('installments')
            .set({
              paid_cents: sql`paid_cents + ${allocation.amount_cents}`,
              status: sql`CASE WHEN paid_cents + ${allocation.amount_cents} >= amount_cents THEN 'paid' ELSE 'processing' END`,
              next_attempt_at: null,
              version: sql`version + 1`,
            })
            .where('org_id', '=', input.orgId)
            .where('id', '=', allocation.installment_id)
            .execute();
        }
        await recomputeInvoiceStatus(
          trx,
          input.orgId,
          allocation.invoice_id,
          todayLocal,
        );
      }
      if (
        allocation.installment_id &&
        (target === 'failed' || target === 'canceled')
      ) {
        const manual = await sql<{ exists: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM manual_installment_payment_attempts
            WHERE org_id = ${input.orgId}::uuid
              AND payment_id = ${payment.id}::uuid
          ) AS exists
        `.execute(trx);
        if (manual.rows[0]?.exists) {
          await recomputeInvoiceStatus(
            trx,
            input.orgId,
            allocation.invoice_id,
            todayLocal,
          );
        } else {
          const installment = await trx
            .selectFrom('installments')
            .select(['attempt_count', 'status'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', allocation.installment_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (installment.status !== 'paid') {
            const retry =
              target === 'failed'
                ? nextInstallmentAttempt(
                    this.now().toString(),
                    installment.attempt_count,
                    failureCode ?? 'unknown',
                    org.timezone,
                  )
                : { retry: false, nextAttemptAt: null, finalFailure: true };
            await trx
              .updateTable('installments')
              .set({
                status: 'failed',
                autopay: retry.retry,
                next_attempt_at: retry.nextAttemptAt
                  ? new Date(retry.nextAttemptAt)
                  : null,
                last_failure_code: failureCode,
                last_failure_message: failureMessage,
                version: sql`version + 1`,
              })
              .where('org_id', '=', input.orgId)
              .where('id', '=', allocation.installment_id)
              .execute();
            if (target === 'failed' && !retry.retry) {
              await applyFinalInstallmentLateFee(trx, context, {
                invoiceId: allocation.invoice_id,
                installmentId: allocation.installment_id,
              });
            }
            await recomputeInvoiceStatus(
              trx,
              input.orgId,
              allocation.invoice_id,
              todayLocal,
            );
            if (!payment.account_id)
              throw new Error('Failed installment lacks a payer account');
            const queued = await enqueueFinanceNotice(trx, context, {
              kind: retry.retry
                ? 'installment_failed'
                : 'installment_final_notice',
              sourceId: payment.id,
              accountId: payment.account_id,
            });
            if (
              queued &&
              method === 'us_bank_account' &&
              payment.processing_started_at
            ) {
              const staff = await activeFinanceNotificationRecipients(
                trx,
                input.orgId,
              );
              for (const accountId of staff) {
                if (accountId === payment.account_id) continue;
                await createNotification(trx, context, {
                  accountId,
                  type: 'installment.failed',
                  payload: {
                    resourceType: 'payment',
                    resourceId: payment.id,
                  },
                });
              }
            }
          }
        }
      }
      await appendAuditEvent(trx, context, {
        action: `payment.${target}`,
        entityType: 'payment',
        entityId: payment.id,
        changes: {
          status: { tier: 'internal', before: payment.status, after: target },
        },
      });
      if (firstSuccess) {
        if (!payment.account_id)
          throw new Error('Successful Stripe payment lacks a payer account');
        await enqueueFinanceNotice(trx, context, {
          kind: 'payment_received',
          sourceId: payment.id,
          accountId: payment.account_id,
        });
      }
      return 'applied';
    });
  }
}
