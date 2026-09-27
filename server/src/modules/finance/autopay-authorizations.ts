import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

export const autopayAuthorizationSchema = z.strictObject({
  id: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.number().int().positive(),
  paymentMethodId: z.uuid(),
  methodType: z.string(),
  last4: z.string().nullable(),
  authorizedAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  mandateTextVersion: z.string(),
  futureInstallments: z.number().int().nonnegative(),
});
export const autopayAuthorizationListSchema = z.strictObject({
  authorizations: z.array(autopayAuthorizationSchema),
});
export type AutopayAuthorization = z.output<typeof autopayAuthorizationSchema>;
export class AutopayAuthorizationNotFoundError extends Error {
  constructor() {
    super('Autopay authorization was not found');
  }
}
export class AutopayAuthorizationConflictError extends Error {}
export const STAFF_METHOD_CONSENT_VERSION = 'staff-method-consent-v1';
export const STAFF_METHOD_CONSENT_TEXT =
  'I authorize this organization to charge my selected saved payment method for future unpaid installments of this invoice. I may stop future automatic charges at any time. A charge already in progress may still complete.';

interface AuthorizationRow {
  id: string;
  invoice_id: string;
  invoice_number: number;
  payment_method_id: string;
  method_type: string;
  last4: string | null;
  authorized_at: Date;
  revoked_at: Date | null;
  mandate_text_version: string;
  future_installments: number;
}

/** Account-owned mandates; revocation stops only future unclaimed installments. */
export class PostgresAutopayAuthorizations {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async authorizeStaffMethod(input: {
    invoiceId: string;
    stripePaymentMethodId: string;
    operationKey: string;
    accepted: boolean;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ id: string; paymentMethodId: string }> {
    const invoiceId = z.uuid().parse(input.invoiceId);
    const key = z.uuid().parse(input.operationKey);
    if (!input.accepted)
      throw new AutopayAuthorizationConflictError('Consent is required');
    if (!/^pm_[A-Za-z0-9_]+$/.test(input.stripePaymentMethodId))
      throw new AutopayAuthorizationConflictError('Invalid saved method');
    const hash = createHash('sha256')
      .update(STAFF_METHOD_CONSENT_TEXT)
      .digest('hex');
    return this.withOrg(this.context, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`.execute(trx);
      const prior = await sql<{
        id: string;
        invoice_id: string;
        account_id: string;
        payment_method_id: string;
        stripe_payment_method_id: string;
        mandate_text_hash: string;
      }>`
        SELECT a.id, a.invoice_id, a.account_id, a.payment_method_id,
          m.stripe_payment_method_id, a.mandate_text_hash
        FROM autopay_authorizations a
        JOIN payment_methods m ON m.id = a.payment_method_id
        WHERE a.org_id = ${this.context.orgId}::uuid
          AND a.operation_key = ${key}::uuid
      `.execute(trx);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (
          row.invoice_id !== invoiceId ||
          row.account_id !== this.context.actor.accountId ||
          row.stripe_payment_method_id !== input.stripePaymentMethodId ||
          row.mandate_text_hash !== hash
        )
          throw new AutopayAuthorizationConflictError('Consent key was reused');
        return { id: row.id, paymentMethodId: row.payment_method_id };
      }
      const invoice = await trx
        .selectFrom('invoices')
        .select(['id', 'status', 'balance_cents'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', invoiceId)
        .where('account_id', '=', this.context.actor.accountId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !invoice ||
        !['open', 'partially_paid', 'past_due'].includes(invoice.status) ||
        !invoice.balance_cents ||
        invoice.balance_cents < 1
      )
        throw new AutopayAuthorizationConflictError('Invoice is not payable');
      const future = await trx
        .selectFrom('installments')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('invoice_id', '=', invoiceId)
        .where('status', 'in', ['scheduled', 'failed'])
        .limit(1)
        .executeTakeFirst();
      if (!future)
        throw new AutopayAuthorizationConflictError(
          'No future installment exists',
        );
      const method = await trx
        .selectFrom('payment_methods')
        .select(['id', 'status', 'type'])
        .where('account_id', '=', this.context.actor.accountId)
        .where('stripe_payment_method_id', '=', input.stripePaymentMethodId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !method ||
        method.status !== 'active' ||
        !['card', 'us_bank_account', 'link'].includes(method.type)
      )
        throw new AutopayAuthorizationConflictError(
          'Saved method is unavailable',
        );
      const id = newId();
      await sql`
        INSERT INTO autopay_authorizations
          (id, org_id, account_id, payment_method_id, invoice_id,
           mandate_text_version, mandate_text_hash, operation_key, ip, user_agent)
        VALUES (${id}::uuid, ${this.context.orgId}::uuid,
          ${this.context.actor.accountId}::uuid, ${method.id}::uuid,
          ${invoiceId}::uuid, ${STAFF_METHOD_CONSENT_VERSION}, ${hash},
          ${key}::uuid, ${input.ip}::inet, ${input.userAgent})
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'finance.autopay_authorized',
        entityType: 'autopay_authorization',
        entityId: id,
        changes: {
          invoiceId: { tier: 'internal', after: invoiceId },
          paymentMethodId: { tier: 'internal', after: method.id },
        },
      });
      return { id, paymentMethodId: method.id };
    });
  }

  async list(): Promise<AutopayAuthorization[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<AuthorizationRow>`
        SELECT a.id, a.invoice_id, i.number AS invoice_number,
          a.payment_method_id, pm.type AS method_type, pm.last4,
          a.authorized_at, a.revoked_at, a.mandate_text_version,
          (SELECT count(*)::integer FROM installments inst
            WHERE inst.org_id = a.org_id AND inst.invoice_id = a.invoice_id
              AND inst.payment_method_id = a.payment_method_id
              AND inst.autopay = true
              AND inst.status IN ('scheduled', 'failed')) AS future_installments
        FROM autopay_authorizations a
        JOIN invoices i ON i.org_id = a.org_id AND i.id = a.invoice_id
          AND i.account_id = a.account_id
        JOIN payment_methods pm ON pm.id = a.payment_method_id
          AND pm.account_id = a.account_id
        WHERE a.org_id = ${this.context.orgId}::uuid
          AND a.account_id = ${this.context.actor.accountId}::uuid
        ORDER BY a.authorized_at DESC, a.id DESC
        LIMIT 100
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'finance.autopay_read',
        entityType: 'organization',
        entityId: this.context.orgId,
        changes: { count: { tier: 'internal', after: rows.rows.length } },
      });
      return rows.rows.map((row) =>
        autopayAuthorizationSchema.parse({
          id: row.id,
          invoiceId: row.invoice_id,
          invoiceNumber: row.invoice_number,
          paymentMethodId: row.payment_method_id,
          methodType: row.method_type,
          last4: row.last4,
          authorizedAt: row.authorized_at.toISOString(),
          revokedAt: row.revoked_at?.toISOString() ?? null,
          mandateTextVersion: row.mandate_text_version,
          futureInstallments: row.future_installments,
        }),
      );
    });
  }

  async revoke(
    id: string,
  ): Promise<{ revoked: boolean; stoppedInstallments: number }> {
    return this.withOrg(this.context, async (trx) => {
      const candidate = await trx
        .selectFrom('autopay_authorizations as a')
        .innerJoin('invoices as i', (join) =>
          join
            .onRef('i.org_id', '=', 'a.org_id')
            .onRef('i.id', '=', 'a.invoice_id')
            .onRef('i.account_id', '=', 'a.account_id'),
        )
        .select(['a.invoice_id', 'a.payment_method_id'])
        .where('a.org_id', '=', this.context.orgId)
        .where('a.account_id', '=', this.context.actor.accountId)
        .where('a.id', '=', id)
        .executeTakeFirst();
      if (!candidate) throw new AutopayAuthorizationNotFoundError();
      // Dunning locks installment rows before reading the mandate. Match that order.
      await trx
        .selectFrom('installments')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('invoice_id', '=', candidate.invoice_id)
        .where('payment_method_id', '=', candidate.payment_method_id)
        .where('status', 'in', ['scheduled', 'failed'])
        .orderBy('id')
        .forUpdate()
        .execute();
      const mandate = await trx
        .selectFrom('autopay_authorizations')
        .select(['invoice_id', 'payment_method_id', 'revoked_at'])
        .where('org_id', '=', this.context.orgId)
        .where('account_id', '=', this.context.actor.accountId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!mandate) throw new AutopayAuthorizationNotFoundError();
      if (mandate.revoked_at) return { revoked: false, stoppedInstallments: 0 };
      if (
        mandate.invoice_id !== candidate.invoice_id ||
        mandate.payment_method_id !== candidate.payment_method_id
      )
        throw new Error('Autopay authorization changed during revocation');
      await trx
        .updateTable('autopay_authorizations')
        .set({ revoked_at: sql`now()` })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .execute();
      const active = await trx
        .selectFrom('autopay_authorizations')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('invoice_id', '=', candidate.invoice_id)
        .where('payment_method_id', '=', candidate.payment_method_id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      const stopped = active
        ? []
        : await trx
            .updateTable('installments')
            .set({
              autopay: false,
              payment_method_id: null,
              next_attempt_at: null,
              version: sql`version + 1`,
            })
            .where('org_id', '=', this.context.orgId)
            .where('invoice_id', '=', candidate.invoice_id)
            .where('payment_method_id', '=', candidate.payment_method_id)
            .where('autopay', '=', true)
            .where('status', 'in', ['scheduled', 'failed'])
            .returning('id')
            .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'finance.autopay_revoked',
        entityType: 'autopay_authorization',
        entityId: id,
        changes: {
          stoppedInstallments: {
            tier: 'internal',
            after: stopped.length,
          },
        },
      });
      return { revoked: true, stoppedInstallments: stopped.length };
    });
  }
}
