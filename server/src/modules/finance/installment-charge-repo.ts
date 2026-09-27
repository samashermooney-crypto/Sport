import { Temporal } from '@js-temporal/polyfill';
import { firstInstallmentAttemptAt } from '@shared/algorithms/dunning-schedule';
import { applicationFee } from '@shared/algorithms/fees';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import type {
  InstallmentChargeClaim,
  InstallmentChargeRepository,
} from './installment-dunning.js';
import { allocatePaymentLines } from './payment-line-allocations.js';

interface AttemptRow {
  id: string;
  lease_token: string;
  org_id: string;
  installment_id: string;
  invoice_id: string;
  account_id: string;
  customer_id: string;
  connected_account_id: string;
  payment_method_id: string;
  method: 'card' | 'us_bank_account' | 'link';
  attempt_number: number;
  amount_cents: number;
  application_fee_cents: number;
  status: string;
}

function claim(row: AttemptRow): InstallmentChargeClaim {
  return {
    id: row.id,
    leaseToken: row.lease_token,
    orgId: row.org_id,
    installmentId: row.installment_id,
    invoiceId: row.invoice_id,
    accountId: row.account_id,
    customerId: row.customer_id,
    connectedAccountId: row.connected_account_id,
    paymentMethodId: row.payment_method_id,
    method: row.method,
    attemptNumber: row.attempt_number,
    amountCents: row.amount_cents,
    applicationFeeCents: row.application_fee_cents,
  };
}

/** One durable external-start fence per installment and attempt number. */
export class PostgresInstallmentChargeRepository implements InstallmentChargeRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly actorAccountId: string,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async claimDue(
    orgId: string,
    now: string,
  ): Promise<InstallmentChargeClaim | null> {
    const instant = Temporal.Instant.from(now);
    const context: OrgContext = {
      orgId,
      actor: { accountId: this.actorAccountId },
    };
    return this.withOrg(context, async (trx) => {
      const resume = await sql<AttemptRow>`
        SELECT * FROM installment_charge_attempts
        WHERE org_id = ${orgId}::uuid AND status = 'reserved'
          AND lease_expires_at <= ${new Date(instant.epochMilliseconds)}
        ORDER BY lease_expires_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      `.execute(trx);
      if (resume.rows[0]) {
        const leaseToken = newId();
        const updated = await sql<AttemptRow>`
          UPDATE installment_charge_attempts
          SET lease_token = ${leaseToken}::uuid,
              lease_expires_at = ${new Date(instant.add({ minutes: 5 }).epochMilliseconds)}
          WHERE org_id = ${orgId}::uuid AND id = ${resume.rows[0].id}::uuid
          RETURNING *
        `.execute(trx);
        const row = updated.rows[0];
        if (!row) throw new Error('Installment lease disappeared');
        return claim(row);
      }
      const org = await trx
        .selectFrom('organizations')
        .select([
          'timezone',
          'application_fee_bps',
          'application_fee_fixed_cents',
        ])
        .where('id', '=', orgId)
        .executeTakeFirstOrThrow();
      const todayLocal = instant
        .toZonedDateTimeISO(org.timezone)
        .toPlainDate()
        .toString();
      const candidates = await trx
        .selectFrom('installments')
        .select([
          'id',
          'invoice_id',
          'due_on',
          'amount_cents',
          'paid_cents',
          'status',
          'autopay',
          'payment_method_id',
          'attempt_count',
          'next_attempt_at',
        ])
        .where('org_id', '=', orgId)
        .where('autopay', '=', true)
        .where('status', 'in', ['scheduled', 'failed'])
        .where(sql<boolean>`due_on <= ${todayLocal}::date`)
        .where('attempt_count', '<', 4)
        .orderBy('due_on')
        .orderBy('id')
        .forUpdate()
        .skipLocked()
        .limit(20)
        .execute();
      for (const installment of candidates) {
        const due =
          installment.attempt_count === 0
            ? firstInstallmentAttemptAt(
                installment.due_on.toISOString().slice(0, 10),
                org.timezone,
              )
            : (installment.next_attempt_at?.toISOString() ?? null);
        if (
          !due ||
          Temporal.Instant.compare(Temporal.Instant.from(due), instant) > 0
        )
          continue;
        const amountCents = installment.amount_cents - installment.paid_cents;
        if (amountCents < 1 || !installment.payment_method_id)
          throw new Error(
            'Due installment has no chargeable balance or method',
          );
        const invoice = await trx
          .selectFrom('invoices')
          .select(['account_id', 'balance_cents', 'status'])
          .where('org_id', '=', orgId)
          .where('id', '=', installment.invoice_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          invoice.status === 'void' ||
          invoice.status === 'draft' ||
          invoice.balance_cents === null
        )
          throw new Error('Due installment invoice is unavailable');
        const pendingAttempts = await sql<{ total: number }>`
          SELECT coalesce(sum(amount_cents), 0)::bigint AS total
          FROM installment_charge_attempts
          WHERE org_id = ${orgId}::uuid AND invoice_id = ${installment.invoice_id}::uuid
            AND status IN ('reserved', 'external_started')
        `.execute(trx);
        const pendingPayments = await sql<{ total: number }>`
          SELECT coalesce(sum(allocation.amount_cents), 0)::bigint AS total
          FROM payment_allocations allocation
          JOIN payments payment ON payment.org_id = allocation.org_id
            AND payment.id = allocation.payment_id
          WHERE allocation.org_id = ${orgId}::uuid
            AND allocation.invoice_id = ${installment.invoice_id}::uuid
            AND payment.status IN ('requires_action', 'processing')
        `.execute(trx);
        if (
          amountCents +
            (pendingAttempts.rows[0]?.total ?? 0) +
            (pendingPayments.rows[0]?.total ?? 0) >
          invoice.balance_cents
        )
          throw new Error(
            'Due installment exceeds uncommitted invoice balance',
          );
        const method = await trx
          .selectFrom('payment_methods')
          .select(['stripe_payment_method_id', 'type', 'status', 'account_id'])
          .where('id', '=', installment.payment_method_id)
          .executeTakeFirstOrThrow();
        if (
          method.status !== 'active' ||
          method.account_id !== invoice.account_id ||
          !['card', 'us_bank_account', 'link'].includes(method.type)
        )
          throw new Error('Due installment payment method is unavailable');
        const authorization = await trx
          .selectFrom('autopay_authorizations')
          .select('id')
          .where('org_id', '=', orgId)
          .where('account_id', '=', invoice.account_id)
          .where('payment_method_id', '=', installment.payment_method_id)
          .where('invoice_id', '=', installment.invoice_id)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (!authorization)
          throw new Error('Due installment has no active mandate');
        const payer = await trx
          .selectFrom('payer_profiles')
          .select('stripe_customer_id')
          .where('account_id', '=', invoice.account_id)
          .executeTakeFirst();
        const connect = await trx
          .selectFrom('payment_accounts')
          .select(['stripe_account_id', 'charges_enabled'])
          .where('org_id', '=', orgId)
          .executeTakeFirst();
        if (
          !payer?.stripe_customer_id ||
          !connect?.stripe_account_id ||
          !connect.charges_enabled
        )
          throw new Error(
            'Due installment payer or Connect account is unavailable',
          );
        const attemptNumber = installment.attempt_count + 1;
        const id = newId();
        const leaseToken = newId();
        const applicationFeeCents = applicationFee(amountCents, {
          bps: org.application_fee_bps,
          fixedCents: org.application_fee_fixed_cents,
        });
        await sql`
          INSERT INTO installment_charge_attempts
            (id, org_id, installment_id, invoice_id, account_id, attempt_number,
             status, lease_token, lease_expires_at, customer_id, connected_account_id,
             payment_method_id, method, amount_cents, application_fee_cents)
          VALUES
            (${id}::uuid, ${orgId}::uuid, ${installment.id}::uuid,
             ${installment.invoice_id}::uuid, ${invoice.account_id}::uuid,
             ${attemptNumber}, 'reserved', ${leaseToken}::uuid,
             ${new Date(instant.add({ minutes: 5 }).epochMilliseconds)},
             ${payer.stripe_customer_id}, ${connect.stripe_account_id},
             ${method.stripe_payment_method_id}, ${method.type},
             ${amountCents}, ${applicationFeeCents})
        `.execute(trx);
        await trx
          .updateTable('installments')
          .set({
            status: 'processing',
            attempt_count: attemptNumber,
            next_attempt_at: null,
            version: sql`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('id', '=', installment.id)
          .execute();
        await appendAuditEvent(trx, context, {
          action: 'installment.charge_claimed',
          entityType: 'installment',
          entityId: installment.id,
          changes: {
            attemptNumber: { tier: 'internal', after: attemptNumber },
          },
        });
        return {
          id,
          leaseToken,
          orgId,
          installmentId: installment.id,
          invoiceId: installment.invoice_id,
          accountId: invoice.account_id,
          customerId: payer.stripe_customer_id,
          connectedAccountId: connect.stripe_account_id,
          paymentMethodId: method.stripe_payment_method_id,
          method: method.type as 'card' | 'us_bank_account' | 'link',
          attemptNumber,
          amountCents,
          applicationFeeCents,
        };
      }
      return null;
    });
  }

  async beginExternal(input: InstallmentChargeClaim): Promise<void> {
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: this.actorAccountId },
    };
    await this.withOrg(context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE installment_charge_attempts
        SET status = 'external_started'
        WHERE org_id = ${input.orgId}::uuid AND id = ${input.id}::uuid
          AND lease_token = ${input.leaseToken}::uuid
          AND status = 'reserved'
        RETURNING id
      `.execute(trx);
      if (!updated.rows.length)
        throw new Error('Installment charge lease is stale');
      const method = await trx
        .selectFrom('payment_methods')
        .select(['id', 'status'])
        .where('stripe_payment_method_id', '=', input.paymentMethodId)
        .executeTakeFirst();
      if (!method || method.status !== 'active')
        throw new Error('Installment method was detached before charge');
      const authorization = await trx
        .selectFrom('autopay_authorizations')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', input.accountId)
        .where('invoice_id', '=', input.invoiceId)
        .where('payment_method_id', '=', method.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!authorization)
        throw new Error('Installment mandate was revoked before charge');
    });
  }

  async recordIntent(
    input: InstallmentChargeClaim,
    paymentIntentId: string,
  ): Promise<void> {
    if (!paymentIntentId.startsWith('pi_'))
      throw new Error('Invalid Stripe PaymentIntent ID');
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: this.actorAccountId },
    };
    await this.withOrg(context, async (trx) => {
      const attempt = await sql<AttemptRow>`
        SELECT * FROM installment_charge_attempts
        WHERE org_id = ${input.orgId}::uuid AND id = ${input.id}::uuid FOR UPDATE
      `.execute(trx);
      const row = attempt.rows[0];
      if (
        !row ||
        row.lease_token !== input.leaseToken ||
        row.status !== 'external_started' ||
        row.amount_cents !== input.amountCents ||
        row.installment_id !== input.installmentId
      )
        throw new Error('Installment charge claim changed before recording');
      const paymentId = newId();
      await sql`
        INSERT INTO payments
          (id, org_id, account_id, method, status, amount_cents,
           application_fee_cents, stripe_payment_intent_id, idempotency_key)
        VALUES
          (${paymentId}::uuid, ${input.orgId}::uuid, ${input.accountId}::uuid,
           ${input.method}, 'requires_action', ${input.amountCents},
           ${input.applicationFeeCents}, ${paymentIntentId}, ${input.id}::uuid)
      `.execute(trx);
      await trx
        .insertInto('payment_allocations')
        .values({
          id: newId(),
          org_id: input.orgId,
          payment_id: paymentId,
          invoice_id: input.invoiceId,
          installment_id: input.installmentId,
          amount_cents: input.amountCents,
        })
        .execute();
      await allocatePaymentLines(trx, {
        orgId: input.orgId,
        invoiceId: input.invoiceId,
        paymentId,
        amountCents: input.amountCents,
      });
      await sql`
        UPDATE installment_charge_attempts
        SET status = 'recorded', stripe_payment_intent_id = ${paymentIntentId}
        WHERE org_id = ${input.orgId}::uuid AND id = ${input.id}::uuid
      `.execute(trx);
      await appendAuditEvent(trx, context, {
        action: 'installment.intent_recorded',
        entityType: 'installment',
        entityId: input.installmentId,
        changes: {
          paymentIntentId: { tier: 'internal', after: paymentIntentId },
        },
      });
    });
  }
}
