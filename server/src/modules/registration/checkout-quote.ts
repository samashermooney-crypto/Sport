import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { allocateOrgNumber } from '../../db/orgCounters.js';
import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import { PostgresCheckoutPricingRepository } from '../checkout/pricing-repo.js';
import { PostgresBasicCheckoutPricingSource } from '../checkout/pricing-source-repo.js';
import {
  assertPricingSnapshot,
  CheckoutPricingService,
} from '../checkout/pricing.js';
import { enqueueFinanceNotice } from '../finance/money-notices.js';
import { refundTermsSchema } from '../finance/refund-terms.js';

import {
  registrationCartSchema,
  RegistrationCheckoutError,
} from './checkout-start.js';
import { refundTermsHash } from './policy-acceptance.js';

const frozenSnapshotSchema = z.object({
  lines: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        'participant',
        'add_on',
        'discount',
        'aid',
        'service_fee',
        'tax',
      ]),
      amountCents: z.number().int(),
      parentLineId: z.string().optional(),
      sourceId: z.string().optional(),
      taxable: z.boolean(),
    }),
  ),
  subtotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  aidCents: z.number().int().nonnegative(),
  creditAppliedCents: z.number().int().nonnegative(),
  serviceFeeCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  invoiceTotalCents: z.number().int().nonnegative(),
  chargeNowCents: z.number().int().nonnegative(),
});

export const checkoutQuoteSchema = z.strictObject({
  checkoutId: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.number().int().positive(),
  totalCents: z.number().int().positive(),
  chargeNowCents: z.number().int().positive(),
  serviceFeeCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  lines: z.array(
    z.strictObject({
      kind: z.string(),
      description: z.string(),
      amountCents: z.number().int(),
    }),
  ),
});

interface LineDescription {
  line_id: string;
  offering_id: string;
  description: string;
  program_id: string;
  division_id: string;
  person_id: string;
  household_id: string;
  has_requirements: boolean;
}

interface ExistingInvoice {
  invoice_id: string;
  number: number;
  total_cents: number;
  balance_cents: number;
}

/** Freezes one quote and atomically issues its invoice plus pending registrations. */
export class PostgresRegistrationCheckoutQuote {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    private readonly database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async quote(input: {
    orgId: string;
    checkoutId: string;
    quoteKey: string;
  }): Promise<z.output<typeof checkoutQuoteSchema>> {
    if (input.orgId !== this.context.orgId)
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Organization mismatch',
      );
    z.uuid().parse(input.checkoutId);
    z.uuid().parse(input.quoteKey);
    const frozen = await new CheckoutPricingService(
      new PostgresCheckoutPricingRepository(
        this.database,
        this.context,
        new PostgresBasicCheckoutPricingSource(),
      ),
    ).freeze({
      orgId: input.orgId,
      checkoutId: input.checkoutId,
      idempotencyKey: input.quoteKey,
    });
    assertPricingSnapshot(frozen.snapshot);
    if (
      frozen.snapshot.chargeNowCents <= 0 ||
      frozen.snapshot.creditAppliedCents !== 0
    )
      throw new RegistrationCheckoutError(
        409,
        'CHECKOUT_UNSUPPORTED',
        'This cart needs another payment path',
      );
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select([
          'account_id',
          'status',
          'expires_at',
          'items',
          'pricing_snapshot',
        ])
        .select(sql<string | null>`invoice_id`.as('invoice_id'))
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !checkout ||
        checkout.account_id !== this.context.actor.accountId ||
        checkout.status !== 'awaiting_payment' ||
        checkout.expires_at <= new Date()
      )
        throw new RegistrationCheckoutError(
          409,
          'CHECKOUT_UNAVAILABLE',
          'Checkout is unavailable',
        );
      const snapshot = frozenSnapshotSchema.parse(checkout.pricing_snapshot);
      assertPricingSnapshot({
        ...snapshot,
        lines: snapshot.lines.map((line) => ({
          id: line.id,
          kind: line.kind,
          amountCents: line.amountCents,
          taxable: line.taxable,
          ...(line.parentLineId ? { parentLineId: line.parentLineId } : {}),
          ...(line.sourceId ? { sourceId: line.sourceId } : {}),
        })),
      });
      if (snapshot.creditAppliedCents !== 0 || snapshot.chargeNowCents <= 0)
        throw new RegistrationCheckoutError(
          409,
          'CHECKOUT_UNSUPPORTED',
          'This cart needs another payment path',
        );
      const cart = registrationCartSchema.parse(checkout.items);
      if (checkout.invoice_id)
        return this.existingQuote(
          trx,
          input.checkoutId,
          checkout.invoice_id,
          snapshot,
        );
      const holds = await trx
        .selectFrom('capacity_holds')
        .select(['expires_at', 'released_at', 'converted_at'])
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .forUpdate()
        .execute();
      if (
        !holds.length ||
        holds.some(
          (hold) =>
            hold.released_at ||
            hold.converted_at ||
            hold.expires_at <= new Date(),
        )
      )
        throw new RegistrationCheckoutError(
          409,
          'HOLD_EXPIRED',
          'The reserved seat has expired',
        );
      const settings = await trx
        .selectFrom('organizations')
        .select('settings')
        .where('id', '=', input.orgId)
        .executeTakeFirstOrThrow();
      const orgSettings = z
        .looseObject({ refundTerms: refundTermsSchema })
        .safeParse(settings.settings);
      if (!orgSettings.success)
        throw new RegistrationCheckoutError(
          409,
          'REFUND_POLICY_REQUIRED',
          'The organization must publish refund terms before paid registration',
        );
      const acceptedHash = refundTermsHash(orgSettings.data.refundTerms);
      const accepted = await sql<{ exists: boolean }>`
        SELECT EXISTS (SELECT 1 FROM checkout_policy_acceptances
          WHERE org_id = ${input.orgId}::uuid
            AND checkout_id = ${input.checkoutId}::uuid
            AND account_id = ${this.context.actor.accountId}::uuid
            AND terms_hash = ${acceptedHash}) AS exists
      `.execute(trx);
      if (!accepted.rows[0]?.exists)
        throw new RegistrationCheckoutError(
          409,
          'REFUND_TERMS_UNACCEPTED',
          'Review and accept the current refund terms',
        );
      const descriptions: LineDescription[] = [];
      for (const item of cart.offerings) {
        const rows = await sql<LineDescription>`
          SELECT ${item.lineId}::uuid::text AS line_id,
            o.id AS offering_id,
            person.first_name || ' ' || person.last_name || ' — ' || o.name AS description,
            o.program_id, o.division_id, person.id AS person_id,
            ${item.householdId}::uuid AS household_id,
            (cardinality(o.form_definition_ids) > 0 OR
             cardinality(o.waiver_document_ids) > 0 OR
             o.requires_approval OR o.registrant_role <> 'athlete') AS has_requirements
          FROM registration_offerings o
          JOIN people person ON person.org_id = o.org_id AND person.id = ${item.personId}::uuid
          WHERE o.org_id = ${input.orgId}::uuid AND o.id = ${item.offeringId}::uuid
            AND o.division_id IS NOT NULL AND person.status = 'active'
          FOR UPDATE OF o, person
        `.execute(trx);
        const row = rows.rows[0];
        if (!row)
          throw new RegistrationCheckoutError(
            409,
            'CHECKOUT_UNAVAILABLE',
            'Offering changed during checkout',
          );
        if (row.has_requirements)
          throw new RegistrationCheckoutError(
            409,
            'REQUIREMENTS_PENDING',
            'Required forms, waivers or approval must be completed before payment',
          );
        descriptions.push(row);
      }
      const byLine = new Map(descriptions.map((item) => [item.line_id, item]));
      if (byLine.size !== cart.offerings.length)
        throw new RegistrationCheckoutError(
          409,
          'CHECKOUT_UNAVAILABLE',
          'Cart lines changed',
        );
      const invoiceId = newId();
      const invoiceNumber = await allocateOrgNumber(
        trx,
        input.orgId,
        'invoice',
      );
      const householdIds = [
        ...new Set(cart.offerings.map((item) => item.householdId)),
      ];
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            snapshot,
            cart,
            terms: orgSettings.data.refundTerms,
          }),
        )
        .digest('hex');
      await sql`
        INSERT INTO invoices
          (id, org_id, number, account_id, household_id, status, issued_at,
           subtotal_cents, discount_cents, service_fee_cents, tax_cents,
           total_cents, source, creation_key, creation_hash, refund_terms)
        VALUES
          (${invoiceId}::uuid, ${input.orgId}::uuid, ${invoiceNumber},
           ${this.context.actor.accountId}::uuid,
           ${householdIds.length === 1 ? householdIds[0] : null}::uuid,
           'open', now(), ${snapshot.subtotalCents},
           ${snapshot.discountCents + snapshot.aidCents},
           ${snapshot.serviceFeeCents}, ${snapshot.taxCents},
           ${snapshot.invoiceTotalCents}, 'checkout', ${input.checkoutId}::uuid,
           ${hash}, ${JSON.stringify(orgSettings.data.refundTerms)}::jsonb)
      `.execute(trx);
      const lineIds = new Map(snapshot.lines.map((line) => [line.id, newId()]));
      const outputLines: z.output<typeof checkoutQuoteSchema>['lines'] = [];
      for (const [index, line] of snapshot.lines.entries()) {
        const lineId = lineIds.get(line.id);
        if (!lineId) throw new Error('Invoice line ID missing');
        const description =
          line.kind === 'participant'
            ? byLine.get(line.id)?.description
            : line.kind === 'service_fee'
              ? 'Service fee'
              : line.kind === 'discount'
                ? 'Registration discount'
                : line.kind === 'aid'
                  ? 'Financial aid'
                  : line.kind === 'tax'
                    ? 'Sales tax'
                    : 'Registration add-on';
        if (
          !description ||
          (line.kind === 'participant' && !byLine.has(line.id))
        )
          throw new RegistrationCheckoutError(
            409,
            'CHECKOUT_UNAVAILABLE',
            'Price line has no participant',
          );
        await sql`
          INSERT INTO invoice_lines
            (id, org_id, invoice_id, kind, description, quantity,
             unit_amount_cents, amount_cents, refundable, parent_line_id,
             checkout_line_index)
          VALUES
            (${lineId}::uuid, ${input.orgId}::uuid, ${invoiceId}::uuid,
             ${line.kind === 'participant' ? 'registration' : line.kind},
             ${description}, 1, ${line.amountCents}, ${line.amountCents},
             ${line.kind !== 'discount' && line.kind !== 'aid'},
             ${line.parentLineId ? (lineIds.get(line.parentLineId) ?? null) : null}::uuid,
             ${index})
        `.execute(trx);
        outputLines.push({
          kind: line.kind,
          description,
          amountCents: line.amountCents,
        });
      }
      for (const [index, item] of cart.offerings.entries()) {
        const detail = descriptions[index];
        const invoiceLineId = lineIds.get(item.lineId);
        if (!detail || !invoiceLineId)
          throw new Error('Registration invoice line is missing');
        const registrationId = newId();
        await trx
          .insertInto('registrations')
          .values({
            id: registrationId,
            org_id: input.orgId,
            program_id: detail.program_id,
            division_id: detail.division_id,
            offering_id: detail.offering_id,
            person_id: detail.person_id,
            household_id: detail.household_id,
            registered_by_account_id: this.context.actor.accountId,
            source: 'online',
            status: 'pending_payment',
            checkout_id: input.checkoutId,
            invoice_line_id: invoiceLineId,
          })
          .execute();
        await trx
          .updateTable('invoice_lines')
          .set({ registration_id: registrationId })
          .where('org_id', '=', input.orgId)
          .where('id', '=', invoiceLineId)
          .execute();
        await trx
          .insertInto('registration_status_history')
          .values({
            id: newId(),
            org_id: input.orgId,
            registration_id: registrationId,
            from_status: null,
            to_status: 'pending_payment',
            actor_account_id: this.context.actor.accountId,
          })
          .execute();
      }
      await sql`UPDATE checkouts SET invoice_id = ${invoiceId}::uuid, version = version + 1
        WHERE org_id = ${input.orgId}::uuid AND id = ${input.checkoutId}::uuid`.execute(
        trx,
      );
      await appendAuditEvent(trx, this.context, {
        action: 'checkout.invoice_issued',
        entityType: 'checkout',
        entityId: input.checkoutId,
        changes: {
          invoiceId: { tier: 'internal', after: invoiceId },
          totalCents: { tier: 'internal', after: snapshot.invoiceTotalCents },
        },
      });
      await enqueueFinanceNotice(trx, this.context, {
        kind: 'invoice_issued',
        sourceId: invoiceId,
        accountId: this.context.actor.accountId,
      });
      return checkoutQuoteSchema.parse({
        checkoutId: input.checkoutId,
        invoiceId,
        invoiceNumber,
        totalCents: snapshot.invoiceTotalCents,
        chargeNowCents: snapshot.chargeNowCents,
        serviceFeeCents: snapshot.serviceFeeCents,
        taxCents: snapshot.taxCents,
        lines: outputLines,
      });
    });
  }

  private async existingQuote(
    trx: OrgTransaction,
    checkoutId: string,
    invoiceId: string,
    snapshot: z.output<typeof frozenSnapshotSchema>,
  ): Promise<z.output<typeof checkoutQuoteSchema>> {
    const invoice = await sql<ExistingInvoice>`
      SELECT id AS invoice_id, number, total_cents, balance_cents FROM invoices
      WHERE org_id = ${this.context.orgId}::uuid AND id = ${invoiceId}::uuid
    `.execute(trx);
    const row = invoice.rows[0];
    if (
      !row ||
      row.total_cents !== snapshot.invoiceTotalCents ||
      row.balance_cents !== snapshot.chargeNowCents
    )
      throw new RegistrationCheckoutError(
        409,
        'QUOTE_CHANGED',
        'Checkout invoice no longer matches its quote',
      );
    const lines = await sql<{
      kind: string;
      description: string;
      amount_cents: number;
    }>`
      SELECT kind, description, amount_cents FROM invoice_lines
      WHERE org_id = ${this.context.orgId}::uuid AND invoice_id = ${invoiceId}::uuid
      ORDER BY checkout_line_index
    `.execute(trx);
    return checkoutQuoteSchema.parse({
      checkoutId,
      invoiceId,
      invoiceNumber: row.number,
      totalCents: row.total_cents,
      chargeNowCents: row.balance_cents,
      serviceFeeCents: snapshot.serviceFeeCents,
      taxCents: snapshot.taxCents,
      lines: lines.rows.map((line) => ({
        kind: line.kind === 'registration' ? 'participant' : line.kind,
        description: line.description,
        amountCents: line.amount_cents,
      })),
    });
  }
}
