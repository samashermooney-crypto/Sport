import { createHash } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { allocate } from '@shared/money';
import { quietHoursDecision } from '@shared/policies/quiet-hours';
import {
  proposeRefund,
  type RefundableLine,
} from '@shared/policies/refund-policy';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { allocateOrgNumber } from '../../db/orgCounters.js';
import type { DB, Json } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import { refundTermsSchema } from '../finance/refund-terms.js';
import { RefundConflictError } from '../finance/refunds.js';

import { RegistrationCheckoutError } from './checkout-start.js';
import { enqueueRegistrationNotice } from './notices.js';
import type {
  RegistrationTransferRefunds,
  RegistrationTransferRefundResult,
} from './transfer-refunds.js';

const programPolicySchema = z.looseObject({
  waitlistMode: z.enum(['auto', 'manual', 'off']).optional(),
  offerExpiryHours: z
    .number()
    .int()
    .min(4)
    .max(24 * 30)
    .optional(),
  approvalDecisionHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .optional(),
  paymentDueHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  chargeAtSubmission: z.boolean().optional(),
  selfCancelBeforeHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 365)
    .optional(),
  collectWaitlistRequirements: z.boolean().optional(),
});

export const myRegistrationListSchema = z.strictObject({
  registrations: z.array(
    z.strictObject({
      id: z.uuid(),
      personId: z.uuid(),
      personName: z.string(),
      programId: z.uuid(),
      programName: z.string(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      status: z.string(),
      statusReason: z.string().nullable(),
      checkoutId: z.uuid().nullable(),
      invoiceId: z.uuid().nullable(),
      approvalPaymentDueAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

export const staffRegistrationSchema = z.strictObject({
  id: z.uuid(),
  personId: z.uuid(),
  personName: z.string(),
  householdId: z.uuid(),
  programId: z.uuid(),
  programName: z.string(),
  offeringId: z.uuid(),
  offeringName: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  checkoutId: z.uuid().nullable(),
  invoiceId: z.uuid().nullable(),
  approvalPaymentDueAt: z.string().nullable(),
  createdAt: z.string(),
});

export const staffRegistrationListSchema = z.strictObject({
  registrations: z.array(staffRegistrationSchema),
});

export const waitlistEntrySchema = z.strictObject({
  id: z.uuid(),
  offeringId: z.uuid(),
  offeringName: z.string(),
  programName: z.string(),
  personId: z.uuid(),
  personName: z.string(),
  position: z.number().int().positive(),
  status: z.string(),
  checkoutId: z.uuid().nullable(),
  offeredAt: z.string().nullable(),
  offerExpiresAt: z.string().nullable(),
});

export const registrationRefundPreviewSchema = z.strictObject({
  registrationId: z.uuid(),
  refundCents: z.number().int().nonnegative(),
  refundBps: z.number().int().min(0).max(10_000),
  requiresApproval: z.boolean(),
  approvalThresholdCents: z.number().int().nonnegative(),
  paidCents: z.number().int().nonnegative(),
});

export const registrationCancelResponseSchema = z.strictObject({
  status: z.enum(['canceled', 'withdrawn']),
  refundProposal: registrationRefundPreviewSchema.nullable(),
});

export const cancelBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(400),
});

export const waitlistJoinBodySchema = z.strictObject({
  offeringId: z.uuid(),
  personId: z.uuid(),
  householdId: z.uuid(),
});

export const approveBodySchema = z.strictObject({
  note: z.string().trim().max(400).optional(),
});

export const transferBodySchema = z.strictObject({
  toOfferingId: z.uuid(),
  financialTreatment: z.enum([
    'carry_payment',
    'refund_difference',
    'charge_difference',
    'no_change',
  ]),
  note: z.string().trim().max(400).optional(),
});

export const registrationTransferResponseSchema = z.strictObject({
  toRegistrationId: z.uuid(),
  differenceCents: z.number().int(),
  refund: z
    .strictObject({
      refundId: z.string().startsWith('re_'),
      status: z.string().min(1),
      amountCents: z.number().int().positive(),
    })
    .optional(),
});

export const staffRegisterBodySchema = z.strictObject({
  personId: z.uuid(),
  householdId: z.uuid(),
  offeringId: z.uuid(),
  skipEligibility: z.boolean().optional(),
  priceOverrideCents: z.number().int().nonnegative().optional(),
  overrideNote: z.string().trim().max(400).optional(),
  collectMethod: z.enum(['payment_link', 'offline', 'waived']),
});

interface RegistrationRow {
  id: string;
  program_id: string;
  division_id: string;
  offering_id: string;
  person_id: string;
  household_id: string;
  status: string;
  checkout_id: string | null;
  invoice_line_id: string | null;
  cancel_idempotency_key: string | null;
  cancel_request_hash: Buffer | null;
  cancel_result: Json | null;
  approval_payment_due_at: Date | null;
}

async function loadRegistration(
  trx: OrgTransaction,
  orgId: string,
  registrationId: string,
): Promise<RegistrationRow> {
  const registration = await trx
    .selectFrom('registrations')
    .select([
      'id',
      'program_id',
      'division_id',
      'offering_id',
      'person_id',
      'household_id',
      'status',
      'checkout_id',
      'invoice_line_id',
      'cancel_idempotency_key',
      'cancel_request_hash',
      'cancel_result',
      'approval_payment_due_at',
    ])
    .where('org_id', '=', orgId)
    .where('id', '=', registrationId)
    .forUpdate()
    .executeTakeFirst();
  if (!registration)
    throw new RegistrationCheckoutError(
      404,
      'NOT_FOUND',
      'Registration is unavailable',
    );
  return registration;
}

export async function requireRegistrationStaff(
  trx: OrgTransaction,
  context: OrgContext,
  scope: {
    programId: string;
    divisionId?: string | null;
    seasonId?: string | null;
    teamSeasonId?: string | null;
  },
): Promise<void> {
  const membership = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!membership)
    throw new RegistrationCheckoutError(
      403,
      'FORBIDDEN',
      'Registration staff access is required',
    );
  const scopes = [
    ...(scope.programId
      ? [
          {
            scope_type: 'program',
            scope_id: scope.programId,
          },
        ]
      : []),
    ...(scope.divisionId
      ? [
          {
            scope_type: 'division',
            scope_id: scope.divisionId,
          },
        ]
      : []),
    ...(scope.seasonId
      ? [
          {
            scope_type: 'season',
            scope_id: scope.seasonId,
          },
        ]
      : []),
    ...(scope.teamSeasonId
      ? [
          {
            scope_type: 'team_season',
            scope_id: scope.teamSeasonId,
          },
        ]
      : []),
  ];
  const assignment = await trx
    .selectFrom('role_assignments')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('role', 'in', ['owner', 'admin', 'registrar'])
    .where('pending_mfa', '=', false)
    .where('revoked_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb.and([eb('scope_type', '=', 'org'), eb('scope_id', 'is', null)]),
        ...scopes.map(({ scope_type, scope_id }) =>
          eb.and([
            eb('scope_type', '=', scope_type),
            eb('scope_id', '=', scope_id),
          ]),
        ),
      ]),
    )
    .executeTakeFirst();
  if (!assignment)
    throw new RegistrationCheckoutError(
      403,
      'FORBIDDEN',
      'Registration staff access is required',
    );
}

export async function staffScopeForProgram(
  trx: OrgTransaction,
  orgId: string,
  programId: string,
  divisionId?: string | null,
  teamSeasonId?: string | null,
): Promise<{
  programId: string;
  divisionId: string | null;
  seasonId: string;
  teamSeasonId: string | null;
}> {
  const program = await trx
    .selectFrom('programs')
    .select('season_id')
    .where('org_id', '=', orgId)
    .where('id', '=', programId)
    .executeTakeFirst();
  if (!program)
    throw new RegistrationCheckoutError(
      404,
      'NOT_FOUND',
      'Program is unavailable',
    );
  return {
    programId,
    divisionId: divisionId ?? null,
    seasonId: program.season_id,
    teamSeasonId: teamSeasonId ?? null,
  };
}

async function history(
  trx: OrgTransaction,
  context: OrgContext,
  registrationId: string,
  from: string | null,
  to: string,
  reason: string | null,
): Promise<void> {
  await trx
    .insertInto('registration_status_history')
    .values({
      id: newId(),
      org_id: context.orgId,
      registration_id: registrationId,
      from_status: from as never,
      to_status: to as never,
      actor_account_id: context.actor.accountId,
      reason,
    })
    .execute();
}

/** One seat back into the confirmed→(release) pool, then offer the waitlist. */
async function releaseConfirmedSeat(
  trx: OrgTransaction,
  context: OrgContext,
  registration: RegistrationRow,
): Promise<void> {
  const subjects = [
    ['program', registration.program_id],
    ['division', registration.division_id],
    ['offering', registration.offering_id],
  ] as const;
  for (const [subject, id] of subjects) {
    const counter = await trx
      .selectFrom('capacity_counters')
      .select(['id', 'confirmed'])
      .where('org_id', '=', context.orgId)
      .where('subject_type', '=', subject)
      .where('subject_id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!counter || counter.confirmed < 1)
      throw new Error('Confirmed capacity does not reconcile');
    await trx
      .updateTable('capacity_counters')
      .set({
        confirmed: sql`confirmed - 1`,
        version: sql`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', counter.id)
      .execute();
  }
}

/** Refund scoped to one registration's invoice-line subtree. */
async function scopedRefundLines(
  trx: OrgTransaction,
  orgId: string,
  registration: RegistrationRow,
): Promise<{
  invoiceId: string;
  paymentId: string | null;
  lines: RefundableLine[];
  paidServiceFeeShareCents: number;
  terms: z.output<typeof refundTermsSchema> | null;
  paidCents: number;
  fullCart: boolean;
}> {
  const invoiceLine = await trx
    .selectFrom('invoice_lines')
    .select(['id', 'invoice_id', 'amount_cents', 'kind'])
    .where('org_id', '=', orgId)
    .where('id', '=', registration.invoice_line_id ?? '')
    .executeTakeFirst();
  if (!invoiceLine)
    return {
      invoiceId: '',
      paymentId: null,
      lines: [],
      paidServiceFeeShareCents: 0,
      terms: null,
      paidCents: 0,
      fullCart: true,
    };
  const invoice = await trx
    .selectFrom('invoices')
    .select(['id', 'refund_terms', 'total_cents', 'paid_cents', 'status'])
    .where('org_id', '=', orgId)
    .where('id', '=', invoiceLine.invoice_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const siblings = await trx
    .selectFrom('registrations')
    .select(['id', 'status'])
    .where('org_id', '=', orgId)
    .where('invoice_line_id', 'is not', null)
    .where(
      'invoice_line_id',
      'in',
      trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('org_id', '=', orgId)
        .where('invoice_id', '=', invoice.id)
        .where('kind', '=', 'registration'),
    )
    .execute();
  const activeSiblings = siblings.filter(
    (row) =>
      row.id !== registration.id &&
      !['canceled', 'withdrawn', 'transferred_out'].includes(row.status),
  );
  const scoped = await sql<{
    id: string;
    amount_cents: number;
    allocated: number;
    refunded: number;
  }>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM invoice_lines
      WHERE org_id = ${orgId}::uuid AND id = ${invoiceLine.id}::uuid
      UNION
      SELECT child.id FROM invoice_lines child
      JOIN subtree s ON child.parent_line_id = s.id
      WHERE child.org_id = ${orgId}::uuid
    )
    SELECT l.id, l.amount_cents,
      coalesce((SELECT sum(a.amount_cents) FROM payment_line_allocations a
        JOIN payments pay ON pay.org_id = a.org_id AND pay.id = a.payment_id
        WHERE a.org_id = l.org_id AND a.invoice_line_id = l.id
          AND pay.status IN ('succeeded', 'processing')), 0)::bigint AS allocated,
      coalesce((SELECT sum(ra.amount_cents) FROM refund_allocations ra
        JOIN refunds r ON r.org_id = ra.org_id AND r.id = ra.refund_id
        WHERE ra.org_id = l.org_id AND ra.invoice_line_id = l.id
          AND r.status = 'succeeded'), 0)::bigint AS refunded
    FROM invoice_lines l JOIN subtree s ON s.id = l.id
    WHERE l.org_id = ${orgId}::uuid
  `.execute(trx);
  const payment = await sql<{ id: string; status: string }>`
    SELECT pay.id, pay.status FROM payments pay
    JOIN payment_allocations a ON a.org_id = pay.org_id
      AND a.payment_id = pay.id AND a.invoice_id = ${invoice.id}::uuid
    WHERE pay.org_id = ${orgId}::uuid
      AND pay.status = 'succeeded'
    ORDER BY pay.created_at DESC LIMIT 1
  `.execute(trx);
  const feeShare = await sql<{ share: number }>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM invoice_lines
      WHERE org_id = ${orgId}::uuid AND id = ${invoiceLine.id}::uuid
      UNION
      SELECT child.id FROM invoice_lines child
      JOIN subtree s ON child.parent_line_id = s.id
      WHERE child.org_id = ${orgId}::uuid
    )
    SELECT coalesce(sum(l.amount_cents), 0)::bigint AS share
    FROM invoice_lines l JOIN subtree s ON s.id = l.id
    WHERE l.org_id = ${orgId}::uuid
  `.execute(trx);
  const lines: RefundableLine[] = scoped.rows
    .filter((row) => row.amount_cents > 0)
    .map((row) => ({
      id: row.id,
      paidCents: Math.max(0, row.allocated),
      previouslyRefundedCents: Math.max(0, row.refunded),
    }));
  const serviceFeeLine = await trx
    .selectFrom('invoice_lines')
    .select('amount_cents')
    .where('org_id', '=', orgId)
    .where('invoice_id', '=', invoice.id)
    .where('kind', '=', 'service_fee')
    .executeTakeFirst();
  const positiveTotal = await sql<{ total: number }>`
    SELECT coalesce(sum(amount_cents), 0)::bigint AS total FROM invoice_lines
    WHERE org_id = ${orgId}::uuid AND invoice_id = ${invoice.id}::uuid
      AND amount_cents > 0 AND kind <> 'service_fee'
  `.execute(trx);
  const feePaid = serviceFeeLine?.amount_cents ?? 0;
  const feeSharePaid =
    positiveTotal.rows[0]?.total && feePaid > 0
      ? (allocate(feePaid, [
          feeShare.rows[0]?.share ?? 0,
          Math.max(
            0,
            positiveTotal.rows[0].total - (feeShare.rows[0]?.share ?? 0),
          ),
        ])[0] ?? 0)
      : 0;
  return {
    invoiceId: invoice.id,
    paymentId: payment.rows[0]?.id ?? null,
    lines,
    paidServiceFeeShareCents: feeSharePaid,
    terms: invoice.refund_terms
      ? refundTermsSchema.parse(invoice.refund_terms)
      : null,
    paidCents: Math.max(
      0,
      scoped.rows.reduce((t, r) => t + r.allocated, 0),
    ),
    fullCart: activeSiblings.length === 0,
  };
}

async function registrationRefundPreview(
  trx: OrgTransaction,
  orgId: string,
  registration: RegistrationRow,
  scope: Awaited<ReturnType<typeof scopedRefundLines>>,
  now: Date,
): Promise<z.output<typeof registrationRefundPreviewSchema> | null> {
  if (!scope.terms || !scope.lines.length || scope.paidCents < 1) return null;
  const organization = await trx
    .selectFrom('organizations')
    .select('timezone')
    .where('id', '=', orgId)
    .executeTakeFirstOrThrow();
  const today = Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(organization.timezone)
    .toPlainDate()
    .toString();
  const computed = proposeRefund(
    scope.lines,
    scope.paidServiceFeeShareCents,
    today,
    scope.terms.policy,
  );
  return registrationRefundPreviewSchema.parse({
    registrationId: registration.id,
    refundCents: computed.totalCents,
    refundBps: computed.refundBps,
    requiresApproval: computed.totalCents > scope.terms.approvalThresholdCents,
    approvalThresholdCents: scope.terms.approvalThresholdCents,
    paidCents: scope.paidCents,
  });
}

export class PostgresRegistrationLifecycle {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly now: () => Date = () => new Date(),
    private readonly transferRefunds?: RegistrationTransferRefunds,
  ) {
    this.withOrg = createWithOrg(database);
  }

  /** Family-facing: every registration on participants the account manages. */
  async listMine(input: {
    orgId: string;
  }): Promise<z.output<typeof myRegistrationListSchema>> {
    const rows = await this.withOrg(this.context, async (trx) => {
      const result = await sql<{
        id: string;
        person_id: string;
        person_name: string;
        program_id: string;
        program_name: string;
        offering_id: string;
        offering_name: string;
        status: string;
        status_reason: string | null;
        checkout_id: string | null;
        invoice_id: string | null;
        approval_payment_due_at: Date | null;
        created_at: Date;
      }>`
        SELECT r.id, r.person_id,
          person.first_name || ' ' || person.last_name AS person_name,
          r.program_id, p.name AS program_name,
          r.offering_id, o.name AS offering_name,
          r.status, r.status_reason, r.checkout_id,
          il.invoice_id, r.approval_payment_due_at, r.created_at
        FROM registrations r
        JOIN people person ON person.org_id = r.org_id AND person.id = r.person_id
        JOIN programs p ON p.org_id = r.org_id AND p.id = r.program_id
        JOIN registration_offerings o ON o.org_id = r.org_id AND o.id = r.offering_id
        LEFT JOIN invoice_lines il ON il.org_id = r.org_id AND il.id = r.invoice_line_id
        WHERE r.org_id = ${input.orgId}::uuid
          AND EXISTS (
            SELECT 1 FROM person_account_links link
            WHERE link.org_id = r.org_id AND link.person_id = r.person_id
              AND link.account_id = ${this.context.actor.accountId}::uuid
              AND link.relationship IN ('self', 'guardian')
              AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL)
        ORDER BY r.created_at DESC LIMIT 200
      `.execute(trx);
      return result.rows;
    });
    return myRegistrationListSchema.parse({
      registrations: rows.map((row) => ({
        id: row.id,
        personId: row.person_id,
        personName: row.person_name,
        programId: row.program_id,
        programName: row.program_name,
        offeringId: row.offering_id,
        offeringName: row.offering_name,
        status: row.status,
        statusReason: row.status_reason,
        checkoutId: row.checkout_id,
        invoiceId: row.invoice_id,
        approvalPaymentDueAt:
          row.approval_payment_due_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
    });
  }

  /** Registrar queue, filtered by the actor's active role scope. */
  async listForStaff(input: {
    orgId: string;
    status?: string;
  }): Promise<z.output<typeof staffRegistrationListSchema>> {
    const rows = await this.withOrg(this.context, async (trx) => {
      const assignment = await trx
        .selectFrom('role_assignments')
        .innerJoin('org_memberships', (join) =>
          join
            .onRef('org_memberships.org_id', '=', 'role_assignments.org_id')
            .onRef(
              'org_memberships.account_id',
              '=',
              'role_assignments.account_id',
            ),
        )
        .select('role_assignments.id')
        .where('role_assignments.org_id', '=', input.orgId)
        .where('role_assignments.account_id', '=', this.context.actor.accountId)
        .where('role_assignments.role', 'in', ['owner', 'admin', 'registrar'])
        .where('role_assignments.pending_mfa', '=', false)
        .where('role_assignments.revoked_at', 'is', null)
        .where('org_memberships.status', '=', 'active')
        .executeTakeFirst();
      if (!assignment)
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Registration staff access is required',
        );
      const result = await sql<{
        id: string;
        person_id: string;
        person_name: string;
        household_id: string;
        program_id: string;
        program_name: string;
        offering_id: string;
        offering_name: string;
        status: string;
        status_reason: string | null;
        checkout_id: string | null;
        invoice_id: string | null;
        approval_payment_due_at: Date | null;
        created_at: Date;
      }>`
        SELECT r.id, r.person_id,
          person.first_name || ' ' || person.last_name AS person_name,
          r.household_id, r.program_id, p.name AS program_name,
          r.offering_id, o.name AS offering_name,
          r.status, r.status_reason, r.checkout_id,
          il.invoice_id, r.approval_payment_due_at, r.created_at
        FROM registrations r
        JOIN people person ON person.org_id = r.org_id AND person.id = r.person_id
        JOIN programs p ON p.org_id = r.org_id AND p.id = r.program_id
        JOIN registration_offerings o ON o.org_id = r.org_id AND o.id = r.offering_id
        LEFT JOIN invoice_lines il ON il.org_id = r.org_id AND il.id = r.invoice_line_id
        WHERE r.org_id = ${input.orgId}::uuid
          AND (${input.status ?? null}::text IS NULL OR r.status = ${input.status ?? null}::text)
          AND EXISTS (
            SELECT 1 FROM role_assignments ra
            JOIN org_memberships membership ON membership.org_id = ra.org_id
              AND membership.account_id = ra.account_id AND membership.status = 'active'
            WHERE ra.org_id = r.org_id AND ra.account_id = ${this.context.actor.accountId}::uuid
              AND ra.role IN ('owner', 'admin', 'registrar')
              AND ra.pending_mfa = false AND ra.revoked_at IS NULL
              AND (
                ra.scope_type = 'org' OR
                (ra.scope_type = 'program' AND ra.scope_id = r.program_id) OR
                (ra.scope_type = 'division' AND ra.scope_id = r.division_id) OR
                (ra.scope_type = 'season' AND ra.scope_id = p.season_id) OR
                (ra.scope_type = 'team_season' AND ra.scope_id = r.team_season_id)
              )
          )
        ORDER BY CASE WHEN r.status = 'pending_approval' THEN 0 ELSE 1 END,
          r.created_at DESC, r.id LIMIT 500
      `.execute(trx);
      return result.rows;
    });
    return staffRegistrationListSchema.parse({
      registrations: rows.map((row) => ({
        id: row.id,
        personId: row.person_id,
        personName: row.person_name,
        householdId: row.household_id,
        programId: row.program_id,
        programName: row.program_name,
        offeringId: row.offering_id,
        offeringName: row.offering_name,
        status: row.status,
        statusReason: row.status_reason,
        checkoutId: row.checkout_id,
        invoiceId: row.invoice_id,
        approvalPaymentDueAt:
          row.approval_payment_due_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
    });
  }

  async previewCancellation(input: {
    orgId: string;
    registrationId: string;
    staff: boolean;
  }): Promise<z.output<typeof registrationRefundPreviewSchema> | null> {
    return this.withOrg(this.context, async (trx) => {
      const registration = await loadRegistration(
        trx,
        input.orgId,
        input.registrationId,
      );
      if (input.staff)
        await requireRegistrationStaff(
          trx,
          this.context,
          await staffScopeForProgram(
            trx,
            input.orgId,
            registration.program_id,
            registration.division_id,
          ),
        );
      else {
        const owned = await sql<{ ok: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM person_account_links link
            WHERE link.org_id = ${input.orgId}::uuid
              AND link.person_id = ${registration.person_id}::uuid
              AND link.account_id = ${this.context.actor.accountId}::uuid
              AND link.relationship IN ('self', 'guardian')
              AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL
          ) AS ok
        `.execute(trx);
        if (!owned.rows[0]?.ok)
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration is unavailable',
          );
      }
      if (
        !['confirmed', 'pending_payment', 'pending_approval'].includes(
          registration.status,
        )
      )
        throw new RegistrationCheckoutError(
          409,
          'NOT_CANCELABLE',
          `A ${registration.status} registration cannot be canceled`,
        );
      const scope = await scopedRefundLines(trx, input.orgId, registration);
      return registrationRefundPreview(
        trx,
        input.orgId,
        registration,
        scope,
        this.now(),
      );
    });
  }

  /**
   * Family or staff cancel/withdraw. Computes the refund from the invoice's
   * frozen terms; refunds beyond the threshold return a proposal for the
   * two-person finance approval queue rather than moving money here.
   */
  async cancel(input: {
    orgId: string;
    registrationId: string;
    reason: string;
    staff: boolean;
    idempotencyKey: string;
  }): Promise<{
    status: 'canceled' | 'withdrawn';
    refundProposal: z.output<typeof registrationRefundPreviewSchema> | null;
  }> {
    const idempotencyKey = z.uuid().parse(input.idempotencyKey);
    const reason = cancelBodySchema.shape.reason.parse(input.reason);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          registrationId: input.registrationId,
          reason,
          staff: input.staff,
          actorAccountId: this.context.actor.accountId,
        }),
      )
      .digest();
    return this.withOrg(this.context, async (trx) => {
      const registration = await loadRegistration(
        trx,
        input.orgId,
        input.registrationId,
      );
      if (input.staff)
        await requireRegistrationStaff(
          trx,
          this.context,
          await staffScopeForProgram(
            trx,
            input.orgId,
            registration.program_id,
            registration.division_id,
          ),
        );
      if (
        registration.cancel_idempotency_key ||
        registration.cancel_request_hash ||
        registration.cancel_result
      ) {
        if (
          registration.cancel_idempotency_key === idempotencyKey &&
          registration.cancel_request_hash?.equals(requestHash) &&
          registration.cancel_result
        )
          return registrationCancelResponseSchema.parse(
            registration.cancel_result,
          );
        throw new RegistrationCheckoutError(
          409,
          'CANCELLATION_ALREADY_RECORDED',
          'This registration already has a cancellation request',
        );
      }
      if (!input.staff) {
        const owned = await sql<{ ok: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM person_account_links link
            WHERE link.org_id = ${input.orgId}::uuid
              AND link.person_id = ${registration.person_id}::uuid
              AND link.account_id = ${this.context.actor.accountId}::uuid
              AND link.relationship IN ('self', 'guardian')
              AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL
          ) AS ok
        `.execute(trx);
        if (!owned.rows[0]?.ok)
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Registration is unavailable',
          );
      }
      if (
        !['confirmed', 'pending_payment', 'pending_approval'].includes(
          registration.status,
        )
      )
        throw new RegistrationCheckoutError(
          409,
          'NOT_CANCELABLE',
          `A ${registration.status} registration cannot be canceled`,
        );
      const previous = registration.status;
      const toStatus = input.staff ? 'canceled' : 'withdrawn';
      const scope = await scopedRefundLines(trx, input.orgId, registration);
      const proposal = await registrationRefundPreview(
        trx,
        input.orgId,
        registration,
        scope,
        this.now(),
      );
      if (
        previous === 'confirmed' ||
        (previous === 'pending_approval' && scope.paidCents > 0)
      )
        await releaseConfirmedSeat(trx, this.context, registration);
      await trx
        .updateTable('registrations')
        .set({
          status: toStatus,
          status_reason: reason,
          canceled_at: this.now(),
          canceled_by: this.context.actor.accountId,
          cancel_idempotency_key: idempotencyKey,
          cancel_request_hash: requestHash,
          cancel_result: {
            status: toStatus,
            refundProposal: proposal,
          } as unknown as Json,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', registration.id)
        .execute();
      await history(
        trx,
        this.context,
        registration.id,
        previous,
        toStatus,
        reason,
      );
      // Unpaid checkout carts collapse: void the checkout invoice and release
      // the held seats so the family owes nothing.
      if (
        previous !== 'confirmed' &&
        registration.checkout_id &&
        scope.fullCart
      ) {
        await this.voidCheckoutInvoice(trx, input.orgId, registration.id);
        await trx
          .updateTable('capacity_holds')
          .set({ released_at: this.now() })
          .where('org_id', '=', input.orgId)
          .where('checkout_id', '=', registration.checkout_id)
          .where('released_at', 'is', null)
          .where('converted_at', 'is', null)
          .execute();
        for (const subject of ['program', 'division', 'offering'] as const) {
          const id =
            subject === 'program'
              ? registration.program_id
              : subject === 'division'
                ? registration.division_id
                : registration.offering_id;
          await trx
            .updateTable('capacity_counters')
            .set({ held: sql`held - 1`, version: sql`version + 1` })
            .where('org_id', '=', input.orgId)
            .where('subject_type', '=', subject)
            .where('subject_id', '=', id)
            .where('held', '>', 0)
            .execute();
        }
        await trx
          .updateTable('checkouts')
          .set({ status: 'expired', version: sql`version + 1` })
          .where('org_id', '=', input.orgId)
          .where('id', '=', registration.checkout_id)
          .where('status', '!=', 'completed')
          .execute();
      }
      await this.advanceWaitlist(trx, input.orgId, registration.offering_id);
      const accountId = await this.payerAccount(trx, registration);
      if (accountId)
        await enqueueRegistrationNotice(trx, this.context, {
          kind: 'registration_canceled',
          sourceId: registration.id,
          accountId,
          payload: { reason, refundCents: proposal?.refundCents },
        });
      await appendAuditEvent(trx, this.context, {
        action: 'registration.canceled',
        entityType: 'registration',
        entityId: registration.id,
        changes: {
          status: { tier: 'internal', before: previous, after: toStatus },
          reason: { tier: 'internal', after: reason },
          refundCents: { tier: 'internal', after: proposal?.refundCents ?? 0 },
        },
      });
      return { status: toStatus, refundProposal: proposal };
    });
  }

  private async voidCheckoutInvoice(
    trx: OrgTransaction,
    orgId: string,
    registrationId: string,
  ): Promise<void> {
    await sql`
      UPDATE invoices i SET status = 'void', voided_at = now(),
        void_reason = 'registration_canceled', version = i.version + 1
      FROM registrations r
      JOIN invoice_lines il ON il.org_id = r.org_id AND il.id = r.invoice_line_id
      WHERE r.org_id = ${orgId}::uuid AND r.id = ${registrationId}::uuid
        AND i.org_id = r.org_id AND i.id = il.invoice_id
        AND i.status IN ('open', 'partially_paid') AND i.paid_cents = 0
        AND NOT EXISTS (
          SELECT 1 FROM registrations sibling
          JOIN invoice_lines il2 ON il2.org_id = sibling.org_id
            AND il2.id = sibling.invoice_line_id
          WHERE sibling.org_id = ${orgId}::uuid AND il2.invoice_id = i.id
            AND sibling.id <> r.id
            AND sibling.status NOT IN ('canceled', 'withdrawn', 'transferred_out'))
    `.execute(trx);
  }

  private async payerAccount(
    trx: OrgTransaction,
    registration: RegistrationRow,
  ): Promise<string | null> {
    if (registration.checkout_id) {
      const checkout = await trx
        .selectFrom('checkouts')
        .select('account_id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', registration.checkout_id)
        .executeTakeFirst();
      if (checkout) return checkout.account_id;
    }
    const link = await trx
      .selectFrom('person_account_links')
      .select('account_id')
      .where('org_id', '=', this.context.orgId)
      .where('person_id', '=', registration.person_id)
      .where('relationship', '=', 'guardian')
      .where('revoked_at', 'is', null)
      .where('verified_at', 'is not', null)
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    return link?.account_id ?? null;
  }

  /**
   * Staff decision on a pending_approval registration. Approve flips to
   * confirmed when already paid/free or to pending_payment with a payment
   * deadline; decline cancels, releases capacity, voids the open invoice and
   * refunds any captured charge in full.
   */
  async decideApproval(input: {
    orgId: string;
    registrationId: string;
    decision: 'approved' | 'declined';
    note?: string;
    idempotencyKey: string;
  }): Promise<{ status: string; paymentDueAt: string | null }> {
    const idempotencyKey = z.uuid().parse(input.idempotencyKey);
    const note = input.note?.trim() || null;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          registrationId: input.registrationId,
          decision: input.decision,
          note,
          actorAccountId: this.context.actor.accountId,
        }),
      )
      .digest();
    return this.withOrg(this.context, async (trx) => {
      const registration = await loadRegistration(
        trx,
        input.orgId,
        input.registrationId,
      );
      await requireRegistrationStaff(
        trx,
        this.context,
        await staffScopeForProgram(
          trx,
          input.orgId,
          registration.program_id,
          registration.division_id,
        ),
      );
      const prior = await trx
        .selectFrom('registration_approvals')
        .select(['decided_by', 'idempotency_key', 'request_hash'])
        .where('org_id', '=', input.orgId)
        .where('registration_id', '=', registration.id)
        .executeTakeFirst();
      if (prior) {
        if (
          prior.decided_by === this.context.actor.accountId &&
          prior.idempotency_key === idempotencyKey &&
          prior.request_hash?.equals(requestHash)
        )
          return {
            status: registration.status,
            paymentDueAt:
              registration.approval_payment_due_at?.toISOString() ?? null,
          };
        throw new RegistrationCheckoutError(
          409,
          'DECISION_ALREADY_RECORDED',
          'This registration already has an approval decision',
        );
      }
      if (registration.status !== 'pending_approval')
        throw new RegistrationCheckoutError(
          409,
          'NOT_PENDING',
          'Registration is not awaiting a decision',
        );
      const program = await trx
        .selectFrom('programs')
        .select(['settings'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', registration.program_id)
        .executeTakeFirstOrThrow();
      const policy = programPolicySchema.parse(program.settings ?? {});
      await trx
        .insertInto('registration_approvals')
        .values({
          id: newId(),
          org_id: input.orgId,
          registration_id: registration.id,
          decision: input.decision,
          decided_by: this.context.actor.accountId,
          note,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
        })
        .execute();
      const accountId = await this.payerAccount(trx, registration);
      if (input.decision === 'declined') {
        const scope = await scopedRefundLines(trx, input.orgId, registration);
        const invoicePaid = await trx
          .selectFrom('invoices')
          .select(['paid_cents'])
          .where('org_id', '=', input.orgId)
          .where(
            'id',
            '=',
            scope.invoiceId || '00000000-0000-0000-0000-000000000000',
          )
          .executeTakeFirst();
        const paid = (invoicePaid?.paid_cents ?? 0) > 0;
        if (paid) {
          // Charge-at-submission carts keep confirmed counters; decline frees
          // the seat. The money itself moves through the finance refund queue.
          await releaseConfirmedSeat(trx, this.context, registration);
        } else if (registration.checkout_id) {
          await trx
            .updateTable('capacity_holds')
            .set({ released_at: this.now() })
            .where('org_id', '=', input.orgId)
            .where('checkout_id', '=', registration.checkout_id)
            .where('released_at', 'is', null)
            .where('converted_at', 'is', null)
            .execute();
          for (const subject of ['program', 'division', 'offering'] as const) {
            const id =
              subject === 'program'
                ? registration.program_id
                : subject === 'division'
                  ? registration.division_id
                  : registration.offering_id;
            await trx
              .updateTable('capacity_counters')
              .set({ held: sql`held - 1`, version: sql`version + 1` })
              .where('org_id', '=', input.orgId)
              .where('subject_type', '=', subject)
              .where('subject_id', '=', id)
              .where('held', '>', 0)
              .execute();
          }
          await trx
            .updateTable('checkouts')
            .set({ status: 'expired', version: sql`version + 1` })
            .where('org_id', '=', input.orgId)
            .where('id', '=', registration.checkout_id)
            .execute();
        }
        await this.voidCheckoutInvoice(trx, input.orgId, registration.id);
        await trx
          .updateTable('registrations')
          .set({
            status: 'canceled',
            status_reason: note ?? 'declined',
            canceled_at: this.now(),
            canceled_by: this.context.actor.accountId,
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('id', '=', registration.id)
          .execute();
        await history(
          trx,
          this.context,
          registration.id,
          'pending_approval',
          'canceled',
          note ?? 'declined',
        );
        await this.advanceWaitlist(trx, input.orgId, registration.offering_id);
        if (accountId)
          await enqueueRegistrationNotice(trx, this.context, {
            kind: 'approval_declined',
            sourceId: registration.id,
            accountId,
            payload: {
              note,
              refundDueCents: paid ? scope.paidCents : 0,
            },
          });
        return { status: 'canceled', paymentDueAt: null };
      }
      // Approved.
      const invoice = await trx
        .selectFrom('invoice_lines')
        .select('invoice_id')
        .where('org_id', '=', input.orgId)
        .where('id', '=', registration.invoice_line_id ?? '')
        .executeTakeFirst();
      const invoiceRow = invoice
        ? await trx
            .selectFrom('invoices')
            .select(['id', 'status', 'paid_cents', 'balance_cents'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', invoice.invoice_id)
            .forUpdate()
            .executeTakeFirstOrThrow()
        : null;
      const alreadyPaid =
        invoiceRow !== null &&
        (invoiceRow.status === 'paid' || (invoiceRow.balance_cents ?? 0) === 0);
      if (alreadyPaid) {
        // Convert held capacity to confirmed in place (the checkout never ran
        // a payment because approval came first or the cart was free).
        if (registration.checkout_id) {
          const holds = await trx
            .selectFrom('capacity_holds')
            .select(['id', 'subject_type', 'subject_id', 'quantity'])
            .where('org_id', '=', input.orgId)
            .where('checkout_id', '=', registration.checkout_id)
            .where('released_at', 'is', null)
            .where('converted_at', 'is', null)
            .execute();
          for (const hold of holds) {
            const counter = await trx
              .selectFrom('capacity_counters')
              .select(['id', 'held'])
              .where('org_id', '=', input.orgId)
              .where('subject_type', '=', hold.subject_type)
              .where('subject_id', '=', hold.subject_id)
              .forUpdate()
              .executeTakeFirst();
            if (!counter || counter.held < hold.quantity)
              throw new Error('Capacity hold does not reconcile');
            await trx
              .updateTable('capacity_counters')
              .set({
                held: sql`held - ${hold.quantity}`,
                confirmed: sql`confirmed + ${hold.quantity}`,
                version: sql`version + 1`,
              })
              .where('org_id', '=', input.orgId)
              .where('id', '=', counter.id)
              .execute();
          }
          await trx
            .updateTable('capacity_holds')
            .set({ converted_at: this.now() })
            .where('org_id', '=', input.orgId)
            .where('checkout_id', '=', registration.checkout_id)
            .execute();
          await trx
            .updateTable('checkouts')
            .set({
              status: 'completed',
              completed_at: this.now(),
              version: sql`version + 1`,
            })
            .where('org_id', '=', input.orgId)
            .where('id', '=', registration.checkout_id)
            .execute();
        }
        await trx
          .updateTable('registrations')
          .set({ status: 'confirmed', version: sql`version + 1` })
          .where('org_id', '=', input.orgId)
          .where('id', '=', registration.id)
          .execute();
        await history(
          trx,
          this.context,
          registration.id,
          'pending_approval',
          'confirmed',
          input.note ?? 'approved',
        );
        if (accountId)
          await enqueueRegistrationNotice(trx, this.context, {
            kind: 'registration_confirmed',
            sourceId: registration.id,
            accountId,
            payload: {},
          });
        return { status: 'confirmed', paymentDueAt: null };
      }
      const dueHours = policy.paymentDueHours ?? 72;
      const dueAt = new Date(this.now().getTime() + dueHours * 3_600_000);
      if (registration.checkout_id) {
        await trx
          .updateTable('capacity_holds')
          .set({ expires_at: dueAt })
          .where('org_id', '=', input.orgId)
          .where('checkout_id', '=', registration.checkout_id)
          .where('released_at', 'is', null)
          .where('converted_at', 'is', null)
          .execute();
        await trx
          .updateTable('checkouts')
          .set({ expires_at: dueAt, version: sql`version + 1` })
          .where('org_id', '=', input.orgId)
          .where('id', '=', registration.checkout_id)
          .execute();
      }
      await trx
        .updateTable('registrations')
        .set({
          status: 'pending_payment',
          approval_payment_due_at: dueAt,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', registration.id)
        .execute();
      await history(
        trx,
        this.context,
        registration.id,
        'pending_approval',
        'pending_payment',
        input.note ?? 'approved',
      );
      if (accountId)
        await enqueueRegistrationNotice(trx, this.context, {
          kind: 'payment_link',
          sourceId: registration.id,
          accountId,
          payload: { dueAt: dueAt.toISOString() },
        });
      return { status: 'pending_payment', paymentDueAt: dueAt.toISOString() };
    });
  }

  /** Family joins a waitlist for a full offering (or pays up front forms first). */
  async joinWaitlist(input: {
    orgId: string;
    offeringId: string;
    personId: string;
    householdId: string;
  }): Promise<z.output<typeof waitlistEntrySchema>> {
    return this.withOrg(this.context, async (trx) => {
      const offering = await trx
        .selectFrom('registration_offerings')
        .select([
          'id',
          'program_id',
          'division_id',
          'capacity',
          'name',
          'waitlist_enabled',
          'active',
          'visibility',
        ])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.offeringId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !offering?.division_id ||
        !offering.active ||
        offering.visibility !== 'public'
      )
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Offering is unavailable',
        );
      if (!offering.waitlist_enabled)
        throw new RegistrationCheckoutError(
          409,
          'WAITLIST_CLOSED',
          'This offering does not take a waitlist',
        );
      const program = await trx
        .selectFrom('programs')
        .select(['name', 'status', 'settings', 'registration_closes_at'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', offering.program_id)
        .executeTakeFirstOrThrow();
      const policy = programPolicySchema.parse(program.settings ?? {});
      if (policy.waitlistMode === 'off')
        throw new RegistrationCheckoutError(
          409,
          'WAITLIST_CLOSED',
          'This program does not take a waitlist',
        );
      if (program.status !== 'registration_open')
        throw new RegistrationCheckoutError(
          409,
          'REGISTRATION_CLOSED',
          'Registration is closed',
        );
      const access = await sql<{ ok: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM person_account_links link
          JOIN household_members member ON member.org_id = link.org_id
            AND member.person_id = link.person_id
            AND member.household_id = ${input.householdId}::uuid
            AND member.removed_at IS NULL
          WHERE link.org_id = ${input.orgId}::uuid
            AND link.person_id = ${input.personId}::uuid
            AND link.account_id = ${this.context.actor.accountId}::uuid
            AND link.relationship IN ('self', 'guardian')
            AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL
        ) AS ok
      `.execute(trx);
      if (!access.rows[0]?.ok)
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Participant is unavailable',
        );
      const existing = await trx
        .selectFrom('waitlist_entries')
        .select([
          'id',
          'household_id',
          'position',
          'status',
          'checkout_id',
          'offered_at',
          'offer_expires_at',
        ])
        .where('org_id', '=', input.orgId)
        .where('offering_id', '=', input.offeringId)
        .where('person_id', '=', input.personId)
        .where('status', 'in', ['waiting', 'offered'])
        .executeTakeFirst();
      if (existing) {
        if (existing.household_id !== input.householdId)
          throw new RegistrationCheckoutError(
            409,
            'ALREADY_WAITLISTED',
            'Participant is already on this waitlist',
          );
        const person = await trx
          .selectFrom('people')
          .select(['first_name', 'last_name'])
          .where('org_id', '=', input.orgId)
          .where('id', '=', input.personId)
          .executeTakeFirstOrThrow();
        return waitlistEntrySchema.parse({
          id: existing.id,
          offeringId: offering.id,
          offeringName: offering.name,
          programName: program.name,
          personId: input.personId,
          personName: `${person.first_name} ${person.last_name}`,
          position: existing.position,
          status: existing.status,
          checkoutId: existing.checkout_id,
          offeredAt: existing.offered_at?.toISOString() ?? null,
          offerExpiresAt: existing.offer_expires_at?.toISOString() ?? null,
        });
      }
      let isFull = false;
      for (const [subject, subjectId] of [
        ['program', offering.program_id],
        ['division', offering.division_id],
        ['offering', offering.id],
      ] as const) {
        const counter = await trx
          .selectFrom('capacity_counters')
          .select(['capacity', 'confirmed', 'held'])
          .where('org_id', '=', input.orgId)
          .where('subject_type', '=', subject)
          .where('subject_id', '=', subjectId)
          .forUpdate()
          .executeTakeFirst();
        const capacity =
          counter?.capacity ??
          (subject === 'offering' ? offering.capacity : null);
        if (
          capacity !== null &&
          (counter?.confirmed ?? 0) + (counter?.held ?? 0) >= capacity
        )
          isFull = true;
      }
      if (!isFull)
        throw new RegistrationCheckoutError(
          409,
          'WAITLIST_NOT_FULL',
          'A waitlist is available after all reserved seats are full',
        );
      const registered = await trx
        .selectFrom('registrations')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('program_id', '=', offering.program_id)
        .where('person_id', '=', input.personId)
        .where('status', 'not in', ['canceled', 'withdrawn', 'transferred_out'])
        .executeTakeFirst();
      if (registered)
        throw new RegistrationCheckoutError(
          409,
          'ALREADY_REGISTERED',
          'Participant already has a registration in this program',
        );
      const last = await sql<{ max_position: number | null }>`
        SELECT max(position) AS max_position FROM waitlist_entries
        WHERE org_id = ${input.orgId}::uuid
          AND offering_id = ${input.offeringId}::uuid
      `.execute(trx);
      const position = (last.rows[0]?.max_position ?? 0) + 1;
      const id = newId();
      await trx
        .insertInto('waitlist_entries')
        .values({
          id,
          org_id: input.orgId,
          offering_id: input.offeringId,
          person_id: input.personId,
          household_id: input.householdId,
          position,
          status: 'waiting',
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'waitlist.joined',
        entityType: 'waitlist_entry',
        entityId: id,
        changes: { position: { tier: 'internal', after: position } },
      });
      await enqueueRegistrationNotice(trx, this.context, {
        kind: 'waitlist_joined',
        sourceId: id,
        accountId: this.context.actor.accountId,
        payload: { offeringId: input.offeringId, position },
      });
      const person = await trx
        .selectFrom('people')
        .select(['first_name', 'last_name'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.personId)
        .executeTakeFirstOrThrow();
      return waitlistEntrySchema.parse({
        id,
        offeringId: offering.id,
        offeringName: offering.name,
        programName: program.name,
        personId: input.personId,
        personName: `${person.first_name} ${person.last_name}`,
        position,
        status: 'waiting',
        checkoutId: null,
        offeredAt: null,
        offerExpiresAt: null,
      });
    });
  }

  async listMyWaitlist(input: {
    orgId: string;
  }): Promise<{ entries: z.output<typeof waitlistEntrySchema>[] }> {
    const rows = await this.withOrg(this.context, async (trx) => {
      const result = await sql<{
        id: string;
        offering_id: string;
        offering_name: string;
        program_name: string;
        person_id: string;
        person_name: string;
        position: number;
        status: string;
        checkout_id: string | null;
        offered_at: Date | null;
        offer_expires_at: Date | null;
      }>`
        SELECT w.id, w.offering_id, o.name AS offering_name,
          p.name AS program_name, w.person_id,
          person.first_name || ' ' || person.last_name AS person_name,
          w.position, w.status, w.checkout_id, w.offered_at, w.offer_expires_at
        FROM waitlist_entries w
        JOIN registration_offerings o ON o.org_id = w.org_id AND o.id = w.offering_id
        JOIN programs p ON p.org_id = w.org_id AND p.id = o.program_id
        JOIN people person ON person.org_id = w.org_id AND person.id = w.person_id
        WHERE w.org_id = ${input.orgId}::uuid
          AND w.status IN ('waiting', 'offered')
          AND EXISTS (
            SELECT 1 FROM person_account_links link
            WHERE link.org_id = w.org_id AND link.person_id = w.person_id
              AND link.account_id = ${this.context.actor.accountId}::uuid
              AND link.relationship IN ('self', 'guardian')
              AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL)
        ORDER BY w.offering_id, w.position
      `.execute(trx);
      return result.rows;
    });
    return {
      entries: rows.map((row) =>
        waitlistEntrySchema.parse({
          id: row.id,
          offeringId: row.offering_id,
          offeringName: row.offering_name,
          programName: row.program_name,
          personId: row.person_id,
          personName: row.person_name,
          position: row.position,
          status: row.status,
          checkoutId: row.checkout_id,
          offeredAt: row.offered_at?.toISOString() ?? null,
          offerExpiresAt: row.offer_expires_at?.toISOString() ?? null,
        }),
      ),
    };
  }

  async listWaitlistForStaff(input: {
    orgId: string;
    offeringId: string;
  }): Promise<{ entries: z.output<typeof waitlistEntrySchema>[] }> {
    const rows = await this.withOrg(this.context, async (trx) => {
      const offering = await trx
        .selectFrom('registration_offerings')
        .select(['program_id', 'division_id'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.offeringId)
        .executeTakeFirst();
      if (!offering)
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Offering is unavailable',
        );
      await requireRegistrationStaff(
        trx,
        this.context,
        await staffScopeForProgram(
          trx,
          input.orgId,
          offering.program_id,
          offering.division_id,
        ),
      );
      const result = await sql<{
        id: string;
        offering_id: string;
        offering_name: string;
        program_name: string;
        person_id: string;
        person_name: string;
        position: number;
        status: string;
        checkout_id: string | null;
        offered_at: Date | null;
        offer_expires_at: Date | null;
      }>`
        SELECT w.id, w.offering_id, o.name AS offering_name,
          p.name AS program_name, w.person_id,
          person.first_name || ' ' || person.last_name AS person_name,
          w.position, w.status, w.checkout_id, w.offered_at, w.offer_expires_at
        FROM waitlist_entries w
        JOIN registration_offerings o ON o.org_id = w.org_id AND o.id = w.offering_id
        JOIN programs p ON p.org_id = w.org_id AND p.id = o.program_id
        JOIN people person ON person.org_id = w.org_id AND person.id = w.person_id
        WHERE w.org_id = ${input.orgId}::uuid
          AND w.offering_id = ${input.offeringId}::uuid
          AND w.status IN ('waiting', 'offered')
        ORDER BY w.position, w.created_at LIMIT 500
      `.execute(trx);
      return result.rows;
    });
    return {
      entries: rows.map((row) =>
        waitlistEntrySchema.parse({
          id: row.id,
          offeringId: row.offering_id,
          offeringName: row.offering_name,
          programName: row.program_name,
          personId: row.person_id,
          personName: row.person_name,
          position: row.position,
          status: row.status,
          checkoutId: row.checkout_id,
          offeredAt: row.offered_at?.toISOString() ?? null,
          offerExpiresAt: row.offer_expires_at?.toISOString() ?? null,
        }),
      ),
    };
  }

  async declineWaitlist(input: {
    orgId: string;
    entryId: string;
    reason: 'declined' | 'expired' | 'removed';
  }): Promise<{ ok: true }> {
    return this.withOrg(this.context, async (trx) => {
      const entry = await trx
        .selectFrom('waitlist_entries')
        .select(['id', 'status', 'checkout_id', 'person_id', 'offering_id'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.entryId)
        .forUpdate()
        .executeTakeFirst();
      if (!entry || !['waiting', 'offered'].includes(entry.status))
        throw new RegistrationCheckoutError(
          409,
          'WAITLIST_CLOSED',
          'Waitlist entry is unavailable',
        );
      if (input.reason === 'declined') {
        const access = await sql<{ ok: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM person_account_links link
            WHERE link.org_id = ${input.orgId}::uuid
              AND link.person_id = ${entry.person_id}::uuid
              AND link.account_id = ${this.context.actor.accountId}::uuid
              AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL
          ) AS ok
        `.execute(trx);
        if (!access.rows[0]?.ok)
          throw new RegistrationCheckoutError(
            403,
            'FORBIDDEN',
            'Waitlist entry is unavailable',
          );
      }
      await trx
        .updateTable('waitlist_entries')
        .set({ status: input.reason, version: sql`version + 1` })
        .where('org_id', '=', input.orgId)
        .where('id', '=', entry.id)
        .execute();
      if (entry.checkout_id) {
        await trx
          .updateTable('capacity_holds')
          .set({ released_at: this.now() })
          .where('org_id', '=', input.orgId)
          .where('checkout_id', '=', entry.checkout_id)
          .where('released_at', 'is', null)
          .where('converted_at', 'is', null)
          .execute();
        const checkout = await trx
          .selectFrom('checkouts')
          .select('items')
          .where('org_id', '=', input.orgId)
          .where('id', '=', entry.checkout_id)
          .executeTakeFirst();
        const items = z
          .looseObject({
            offerings: z.array(z.looseObject({ offeringId: z.string() })),
          })
          .safeParse(checkout?.items);
        if (items.success) {
          const offering = await trx
            .selectFrom('registration_offerings')
            .select(['program_id', 'division_id'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', items.data.offerings[0]?.offeringId ?? '')
            .executeTakeFirst();
          if (offering) {
            const subjects = [
              ['program', offering.program_id],
              ['division', offering.division_id],
              ['offering', items.data.offerings[0]?.offeringId],
            ] as const;
            for (const [subject, id] of subjects) {
              if (!id) continue;
              await trx
                .updateTable('capacity_counters')
                .set({ held: sql`held - 1`, version: sql`version + 1` })
                .where('org_id', '=', input.orgId)
                .where('subject_type', '=', subject)
                .where('subject_id', '=', id)
                .where('held', '>', 0)
                .execute();
            }
          }
        }
        await trx
          .updateTable('checkouts')
          .set({ status: 'expired', version: sql`version + 1` })
          .where('org_id', '=', input.orgId)
          .where('id', '=', entry.checkout_id)
          .execute();
      }
      await this.advanceWaitlist(trx, input.orgId, entry.offering_id);
      await appendAuditEvent(trx, this.context, {
        action: `waitlist.${input.reason}`,
        entityType: 'waitlist_entry',
        entityId: entry.id,
        changes: {},
      });
      return { ok: true };
    });
  }

  /**
   * Offer the next (or a staff-selected) waiting entry: create a resumable
   * checkout, hold the freed seat until the offer expiry (default 48 h, min 4,
   * never inside quiet hours) and queue the notice in the same transaction.
   */
  async offerWaitlist(input: {
    orgId: string;
    offeringId: string;
    entryId?: string;
    idempotencyKey: string;
  }): Promise<{ entryId: string; expiresAt: string } | 'full' | 'empty'> {
    return this.withOrg(this.context, (trx) =>
      this.offerWaitlistInTransaction(trx, input, true),
    );
  }

  private async offerWaitlistInTransaction(
    trx: OrgTransaction,
    input: {
      orgId: string;
      offeringId: string;
      entryId?: string;
      idempotencyKey: string;
    },
    requireStaff: boolean,
  ): Promise<{ entryId: string; expiresAt: string } | 'full' | 'empty'> {
    const reservationKey = z.uuid().parse(input.idempotencyKey);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          offeringId: input.offeringId,
          entryId: input.entryId ?? null,
          actorAccountId: this.context.actor.accountId,
        }),
      )
      .digest('hex');
    const offering = await trx
      .selectFrom('registration_offerings')
      .select([
        'id',
        'program_id',
        'division_id',
        'capacity',
        'name',
        'waitlist_enabled',
        'active',
      ])
      .where('org_id', '=', input.orgId)
      .where('id', '=', input.offeringId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (requireStaff)
      await requireRegistrationStaff(
        trx,
        this.context,
        await staffScopeForProgram(
          trx,
          input.orgId,
          offering.program_id,
          offering.division_id,
        ),
      );
    const replay = await trx
      .selectFrom('waitlist_entries')
      .select(['id', 'offer_expires_at', 'offer_request_hash'])
      .where('org_id', '=', input.orgId)
      .where('offer_idempotency_key', '=', reservationKey)
      .executeTakeFirst();
    if (replay) {
      if (replay.offer_request_hash?.toString('hex') !== requestHash)
        throw new RegistrationCheckoutError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Waitlist offer key was used for a different request',
        );
      if (!replay.offer_expires_at)
        throw new Error('Waitlist offer replay has no expiry');
      return {
        entryId: replay.id,
        expiresAt: replay.offer_expires_at.toISOString(),
      };
    }
    const program = await trx
      .selectFrom('programs')
      .select(['settings', 'name'])
      .where('org_id', '=', input.orgId)
      .where('id', '=', offering.program_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const policy = programPolicySchema.parse(program.settings ?? {});
    const organization = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', input.orgId)
      .executeTakeFirstOrThrow();
    const counter = await trx
      .selectFrom('capacity_counters')
      .select(['capacity', 'confirmed', 'held'])
      .where('org_id', '=', input.orgId)
      .where('subject_type', '=', 'offering')
      .where('subject_id', '=', input.offeringId)
      .forUpdate()
      .executeTakeFirst();
    const capacity = counter?.capacity ?? offering.capacity ?? null;
    if (
      capacity !== null &&
      (counter?.confirmed ?? 0) + (counter?.held ?? 0) >= capacity
    )
      return 'full';
    const entry = input.entryId
      ? await trx
          .selectFrom('waitlist_entries')
          .select(['id', 'person_id', 'household_id', 'status'])
          .where('org_id', '=', input.orgId)
          .where('id', '=', input.entryId)
          .where('offering_id', '=', input.offeringId)
          .forUpdate()
          .executeTakeFirst()
      : (
          await trx
            .selectFrom('waitlist_entries')
            .select(['id', 'person_id', 'household_id', 'status'])
            .where('org_id', '=', input.orgId)
            .where('offering_id', '=', input.offeringId)
            .where('status', '=', 'waiting')
            .orderBy('position')
            .orderBy('created_at')
            .limit(1)
            .forUpdate()
            .execute()
        )[0];
    if (!entry || entry.status !== 'waiting') return 'empty';
    // One active offer per participant per program.
    const conflicting = await sql<{ exists: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM waitlist_entries w
          JOIN registration_offerings o ON o.org_id = w.org_id AND o.id = w.offering_id
          WHERE w.org_id = ${input.orgId}::uuid AND o.program_id = ${offering.program_id}::uuid
            AND w.person_id = ${entry.person_id}::uuid AND w.status = 'offered'
        ) AS exists
      `.execute(trx);
    if (conflicting.rows[0]?.exists) return 'empty';
    const accountId = await this.payerAccount(trx, {
      person_id: entry.person_id,
    } as RegistrationRow);
    if (!accountId) return 'empty';
    const quiet = quietHoursDecision(
      this.now().toISOString(),
      organization.timezone,
      'push',
      false,
    );
    const sendAt = quiet.sendNow
      ? this.now()
      : new Date(quiet.nextSendAt ?? this.now().toISOString());
    const expiryHours = policy.offerExpiryHours ?? 48;
    const expiresAt = new Date(sendAt.getTime() + expiryHours * 3_600_000);
    const checkoutId = newId();
    const cart = {
      offerings: [
        {
          lineId: newId(),
          offeringId: input.offeringId,
          personId: entry.person_id,
          householdId: entry.household_id,
        },
      ],
    };
    await trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: input.orgId,
        account_id: accountId,
        status: 'open',
        expires_at: expiresAt,
        items: cart as unknown as Json,
        creation_key: reservationKey,
        creation_hash: requestHash,
        source: 'waitlist_offer',
      })
      .execute();
    for (const subject of ['program', 'division', 'offering'] as const) {
      const subjectId =
        subject === 'program'
          ? offering.program_id
          : subject === 'division'
            ? offering.division_id
            : offering.id;
      if (!subjectId) continue;
      const counterRow = await trx
        .selectFrom('capacity_counters')
        .select(['id'])
        .where('org_id', '=', input.orgId)
        .where('subject_type', '=', subject)
        .where('subject_id', '=', subjectId)
        .forUpdate()
        .executeTakeFirst();
      if (counterRow) {
        await trx
          .updateTable('capacity_counters')
          .set({ held: sql`held + 1`, version: sql`version + 1` })
          .where('org_id', '=', input.orgId)
          .where('id', '=', counterRow.id)
          .execute();
      }
      await trx
        .insertInto('capacity_holds')
        .values({
          id: newId(),
          org_id: input.orgId,
          checkout_id: checkoutId,
          subject_type: subject,
          subject_id: subjectId,
          quantity: 1,
          expires_at: expiresAt,
          reservation_key: reservationKey,
        })
        .execute();
    }
    await trx
      .updateTable('waitlist_entries')
      .set({
        status: 'offered',
        offered_at: sendAt,
        offer_expires_at: expiresAt,
        checkout_id: checkoutId,
        offer_idempotency_key: reservationKey,
        offer_request_hash: Buffer.from(requestHash, 'hex'),
        version: sql`version + 1`,
      })
      .where('org_id', '=', input.orgId)
      .where('id', '=', entry.id)
      .execute();
    await enqueueRegistrationNotice(trx, this.context, {
      kind: 'waitlist_offer',
      sourceId: entry.id,
      accountId,
      payload: {
        offeringId: input.offeringId,
        expiresAt: expiresAt.toISOString(),
      },
    });
    await appendAuditEvent(trx, this.context, {
      action: 'waitlist.offered',
      entityType: 'waitlist_entry',
      entityId: entry.id,
      changes: {
        expiresAt: { tier: 'internal', after: expiresAt.toISOString() },
      },
    });
    return { entryId: entry.id, expiresAt: expiresAt.toISOString() };
  }

  /** The family accepts an offer — its checkout resumes through quote+pay. */
  async acceptWaitlist(input: {
    orgId: string;
    entryId: string;
  }): Promise<{ checkoutId: string }> {
    const entryId = await this.withOrg(this.context, async (trx) => {
      const entry = await trx
        .selectFrom('waitlist_entries')
        .select([
          'id',
          'status',
          'checkout_id',
          'person_id',
          'household_id',
          'offer_expires_at',
          'accepted_at',
        ])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.entryId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !entry ||
        entry.status !== 'offered' ||
        !entry.checkout_id ||
        (entry.offer_expires_at && entry.offer_expires_at <= this.now())
      )
        throw new RegistrationCheckoutError(
          409,
          'OFFER_UNAVAILABLE',
          'This waitlist offer is no longer available',
        );
      const access = await sql<{ ok: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM person_account_links link
          JOIN household_members member ON member.org_id = link.org_id
            AND member.person_id = link.person_id
            AND member.household_id = ${entry.household_id}::uuid
            AND member.removed_at IS NULL
          JOIN households h ON h.org_id = member.org_id
            AND h.id = member.household_id AND h.status = 'active'
          WHERE link.org_id = ${input.orgId}::uuid
            AND link.person_id = ${entry.person_id}::uuid
            AND link.account_id = ${this.context.actor.accountId}::uuid
            AND link.relationship IN ('self', 'guardian')
            AND link.revoked_at IS NULL AND link.verified_at IS NOT NULL
        ) AS ok
      `.execute(trx);
      if (!access.rows[0]?.ok)
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Waitlist offer is unavailable',
        );
      const checkout = await trx
        .selectFrom('checkouts')
        .select(['status', 'expires_at'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', entry.checkout_id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !checkout ||
        checkout.status === 'expired' ||
        checkout.expires_at <= this.now()
      )
        throw new RegistrationCheckoutError(
          409,
          'OFFER_UNAVAILABLE',
          'This waitlist offer is no longer available',
        );
      if (!entry.accepted_at) {
        await trx
          .updateTable('waitlist_entries')
          .set({ accepted_at: this.now(), version: sql`version + 1` })
          .where('org_id', '=', input.orgId)
          .where('id', '=', entry.id)
          .execute();
        await appendAuditEvent(trx, this.context, {
          action: 'waitlist.offer_accepted',
          entityType: 'waitlist_entry',
          entityId: entry.id,
          changes: {
            checkoutId: { tier: 'internal', after: entry.checkout_id },
          },
        });
      }
      return entry.checkout_id;
    });
    return { checkoutId: entryId };
  }

  /**
   * Advance a waitlist while seats remain: expire stale offers, release their
   * held capacity and offer the next waiting entry under auto mode.
   */
  async advanceWaitlist(
    trx: OrgTransaction,
    orgId: string,
    offeringId: string,
  ): Promise<void> {
    const stale = await trx
      .selectFrom('waitlist_entries')
      .select(['id', 'checkout_id'])
      .where('org_id', '=', orgId)
      .where('offering_id', '=', offeringId)
      .where('status', '=', 'offered')
      .where('offer_expires_at', '<=', this.now())
      .forUpdate()
      .execute();
    for (const entry of stale) {
      await trx
        .updateTable('waitlist_entries')
        .set({ status: 'expired', version: sql`version + 1` })
        .where('org_id', '=', orgId)
        .where('id', '=', entry.id)
        .execute();
      if (entry.checkout_id) {
        const holds = await trx
          .selectFrom('capacity_holds')
          .select(['subject_type', 'subject_id', 'released_at', 'converted_at'])
          .where('org_id', '=', orgId)
          .where('checkout_id', '=', entry.checkout_id)
          .execute();
        for (const hold of holds) {
          if (hold.released_at || hold.converted_at) continue;
          await trx
            .updateTable('capacity_counters')
            .set({ held: sql`held - 1`, version: sql`version + 1` })
            .where('org_id', '=', orgId)
            .where('subject_type', '=', hold.subject_type)
            .where('subject_id', '=', hold.subject_id)
            .where('held', '>', 0)
            .execute();
        }
        await trx
          .updateTable('capacity_holds')
          .set({ released_at: this.now() })
          .where('org_id', '=', orgId)
          .where('checkout_id', '=', entry.checkout_id)
          .where('released_at', 'is', null)
          .execute();
        await trx
          .updateTable('checkouts')
          .set({ status: 'expired', version: sql`version + 1` })
          .where('org_id', '=', orgId)
          .where('id', '=', entry.checkout_id)
          .execute();
      }
    }
    const program = await trx
      .selectFrom('registration_offerings')
      .select('program_id')
      .where('org_id', '=', orgId)
      .where('id', '=', offeringId)
      .executeTakeFirstOrThrow();
    const settings = await trx
      .selectFrom('programs')
      .select('settings')
      .where('org_id', '=', orgId)
      .where('id', '=', program.program_id)
      .executeTakeFirstOrThrow();
    const policy = programPolicySchema.parse(settings.settings ?? {});
    if ((policy.waitlistMode ?? 'auto') !== 'auto') return;
    const waiting = await trx
      .selectFrom('waitlist_entries')
      .select('id')
      .where('org_id', '=', orgId)
      .where('offering_id', '=', offeringId)
      .where('status', '=', 'waiting')
      .orderBy('position')
      .limit(1)
      .executeTakeFirst();
    if (!waiting) return;
    await this.offerWaitlistInTransaction(
      trx,
      {
        orgId,
        offeringId,
        entryId: waiting.id,
        idempotencyKey: newId(),
      },
      false,
    );
  }

  /**
   * Staff transfer: move a confirmed/pending registration to another offering
   * with capacity, preserving its status, then settle the price difference as
   * carried, collected, refunded or untouched per the chosen treatment.
   */
  async transfer(input: {
    orgId: string;
    registrationId: string;
    toOfferingId: string;
    financialTreatment:
      'carry_payment' | 'refund_difference' | 'charge_difference' | 'no_change';
    note?: string;
    idempotencyKey: string;
  }): Promise<z.output<typeof registrationTransferResponseSchema>> {
    return this.withOrg(this.context, async (trx) => {
      const key = z.uuid().parse(input.idempotencyKey);
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            registrationId: input.registrationId,
            toOfferingId: input.toOfferingId,
            financialTreatment: input.financialTreatment,
            note: input.note?.trim() || null,
            actorAccountId: this.context.actor.accountId,
          }),
        )
        .digest();
      const source = await loadRegistration(
        trx,
        input.orgId,
        input.registrationId,
      );
      await requireRegistrationStaff(
        trx,
        this.context,
        await staffScopeForProgram(
          trx,
          input.orgId,
          source.program_id,
          source.division_id,
        ),
      );
      const prior = await trx
        .selectFrom('transfers')
        .select([
          'from_registration_id',
          'to_registration_id',
          'request_hash',
          'result',
        ])
        .where('org_id', '=', input.orgId)
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      if (prior) {
        if (
          prior.from_registration_id !== source.id ||
          !prior.request_hash?.equals(requestHash)
        )
          throw new RegistrationCheckoutError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Transfer key was used for a different request',
          );
        const priorResult = z
          .looseObject({
            differenceCents: z.number().int().optional(),
            refund: z
              .strictObject({
                refundId: z.string().startsWith('re_'),
                status: z.string().min(1),
                amountCents: z.number().int().positive(),
              })
              .optional(),
          })
          .parse(prior.result);
        return {
          toRegistrationId: prior.to_registration_id,
          differenceCents: priorResult.differenceCents ?? 0,
          ...(priorResult.refund ? { refund: priorResult.refund } : {}),
        };
      }
      if (
        !['confirmed', 'pending_payment', 'pending_approval'].includes(
          source.status,
        )
      )
        throw new RegistrationCheckoutError(
          409,
          'NOT_TRANSFERABLE',
          `A ${source.status} registration cannot be transferred`,
        );
      const destination = await trx
        .selectFrom('registration_offerings')
        .select([
          'id',
          'program_id',
          'division_id',
          'price_cents',
          'active',
          'requires_approval',
        ])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.toOfferingId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !destination?.division_id ||
        !destination.active ||
        destination.id === source.offering_id
      )
        throw new RegistrationCheckoutError(
          409,
          'DESTINATION_UNAVAILABLE',
          'Destination offering is unavailable',
        );
      await requireRegistrationStaff(
        trx,
        this.context,
        await staffScopeForProgram(
          trx,
          input.orgId,
          destination.program_id,
          destination.division_id,
        ),
      );
      const duplicate = await trx
        .selectFrom('registrations')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('program_id', '=', destination.program_id)
        .where('person_id', '=', source.person_id)
        .where('status', 'not in', ['canceled', 'withdrawn', 'transferred_out'])
        .executeTakeFirst();
      if (duplicate && destination.program_id !== source.program_id)
        throw new RegistrationCheckoutError(
          409,
          'ALREADY_REGISTERED',
          'Participant already has a registration in the destination program',
        );
      // Lock every destination counter before any refund call so the price
      // adjustment cannot be issued for a seat that another checkout takes.
      for (const [subject, subjectId] of [
        ['program', destination.program_id],
        ['division', destination.division_id],
        ['offering', destination.id],
      ] as const) {
        const counter = await trx
          .selectFrom('capacity_counters')
          .select(['capacity', 'confirmed', 'held'])
          .where('org_id', '=', input.orgId)
          .where('subject_type', '=', subject)
          .where('subject_id', '=', subjectId)
          .forUpdate()
          .executeTakeFirst();
        if (
          counter?.capacity !== null &&
          counter !== undefined &&
          counter.confirmed + counter.held >= counter.capacity
        )
          throw new RegistrationCheckoutError(
            409,
            'CAPACITY_FULL',
            'Destination is full',
          );
      }
      const sourceLine = source.invoice_line_id
        ? await trx
            .selectFrom('invoice_lines')
            .select(['id', 'amount_cents', 'invoice_id'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', source.invoice_line_id)
            .executeTakeFirst()
        : null;
      const sourceInvoice = sourceLine
        ? await trx
            .selectFrom('invoices')
            .select(['id', 'account_id', 'refund_terms'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', sourceLine.invoice_id)
            .executeTakeFirst()
        : null;
      let sourceNetPriceCents = sourceLine?.amount_cents ?? 0;
      if (sourceLine) {
        if (
          !Number.isSafeInteger(sourceLine.amount_cents) ||
          sourceLine.amount_cents < 0
        )
          throw new RegistrationCheckoutError(
            409,
            'NOT_TRANSFERABLE',
            'The registration line price does not reconcile',
          );
        const sourceAdjustments = await trx
          .selectFrom('invoice_lines')
          .select(['kind', 'amount_cents'])
          .where('org_id', '=', input.orgId)
          .where('invoice_id', '=', sourceLine.invoice_id)
          .where('parent_line_id', '=', sourceLine.id)
          .execute();
        if (
          sourceAdjustments.some(
            (line) =>
              !Number.isSafeInteger(line.amount_cents) ||
              (['discount', 'aid'].includes(line.kind) &&
                line.amount_cents > 0) ||
              (!['discount', 'aid'].includes(line.kind) &&
                line.amount_cents < 0),
          )
        )
          throw new RegistrationCheckoutError(
            409,
            'NOT_TRANSFERABLE',
            'The registration line has unsupported child charges; request a finance-reviewed transfer quote',
          );
        sourceNetPriceCents += sourceAdjustments.reduce(
          (sum, line) =>
            sum +
            (['discount', 'aid'].includes(line.kind) ? line.amount_cents : 0),
          0,
        );
        if (
          !Number.isSafeInteger(sourceNetPriceCents) ||
          sourceNetPriceCents < 0
        )
          throw new RegistrationCheckoutError(
            409,
            'NOT_TRANSFERABLE',
            'The registration net price does not reconcile',
          );
      }
      if (!Number.isSafeInteger(destination.price_cents))
        throw new RegistrationCheckoutError(
          409,
          'NOT_TRANSFERABLE',
          'The destination price does not reconcile',
        );
      const difference = destination.price_cents - sourceNetPriceCents;
      if (!Number.isSafeInteger(difference))
        throw new RegistrationCheckoutError(
          409,
          'NOT_TRANSFERABLE',
          'The transfer price difference does not reconcile',
        );
      let refund: RegistrationTransferRefundResult | null = null;
      if (input.financialTreatment === 'refund_difference') {
        if (
          difference >= 0 ||
          !sourceLine ||
          !sourceInvoice ||
          !this.transferRefunds
        )
          throw new RegistrationCheckoutError(
            409,
            'NOT_TRANSFERABLE',
            'A transfer refund requires a cheaper destination, a paid registration line, and the test-mode finance gateway',
          );
        if (source.status !== 'confirmed')
          throw new RegistrationCheckoutError(
            409,
            'NOT_TRANSFERABLE',
            'Only confirmed paid registrations can receive a transfer refund',
          );
        const timezone = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', input.orgId)
          .executeTakeFirstOrThrow();
        const cancellationDate = Temporal.Instant.from(this.now().toISOString())
          .toZonedDateTimeISO(timezone.timezone)
          .toPlainDate()
          .toString();
        try {
          refund = await this.transferRefunds.refundExactLine({
            orgId: input.orgId,
            invoiceLineId: sourceLine.id,
            amountCents: -difference,
            cancellationDate,
            requestedByAccountId: this.context.actor.accountId,
            idempotencyKey: key,
          });
        } catch (error) {
          if (error instanceof RefundConflictError)
            throw new RegistrationCheckoutError(
              409,
              'NOT_TRANSFERABLE',
              error.message,
            );
          throw new RegistrationCheckoutError(
            503,
            'NOT_TRANSFERABLE',
            'The transfer refund could not be confirmed; retry with the same idempotency key',
          );
        }
        if (refund.amountCents < -difference)
          throw new RegistrationCheckoutError(
            503,
            'NOT_TRANSFERABLE',
            'Recorded transfer refund is below the approved price difference',
          );
      }
      if (
        input.financialTreatment === 'charge_difference' &&
        (difference <= 0 || !sourceLine || !sourceInvoice)
      )
        throw new RegistrationCheckoutError(
          409,
          'NOT_TRANSFERABLE',
          'A charge difference requires a higher-priced destination and an issued source invoice',
        );
      const toId = newId();
      const sameStatus =
        source.status === 'pending_approval' && !destination.requires_approval
          ? 'confirmed'
          : source.status;
      await trx
        .insertInto('registrations')
        .values({
          id: toId,
          org_id: input.orgId,
          program_id: destination.program_id,
          division_id: destination.division_id,
          offering_id: destination.id,
          person_id: source.person_id,
          household_id: source.household_id,
          registered_by_account_id: this.context.actor.accountId,
          source: 'transfer',
          status: sameStatus,
          transferred_from_id: source.id,
          invoice_line_id: source.invoice_line_id,
          checkout_id: source.checkout_id,
        })
        .execute();
      await trx
        .updateTable('registrations')
        .set({
          status: 'transferred_out',
          status_reason: input.note ?? 'transferred',
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', source.id)
        .execute();
      await history(
        trx,
        this.context,
        source.id,
        source.status,
        'transferred_out',
        input.note ?? null,
      );
      await history(
        trx,
        this.context,
        toId,
        null,
        sameStatus,
        `transfer from ${source.id}`,
      );
      // Capacity: free the source seat (confirmed or held) and take the
      // destination seat under the same transaction.
      if (source.status === 'confirmed')
        await releaseConfirmedSeat(trx, this.context, source);
      else if (source.checkout_id) {
        await trx
          .updateTable('capacity_holds')
          .set({ released_at: this.now() })
          .where('org_id', '=', input.orgId)
          .where('checkout_id', '=', source.checkout_id)
          .where('released_at', 'is', null)
          .where('converted_at', 'is', null)
          .execute();
        for (const subject of ['program', 'division', 'offering'] as const) {
          const id =
            subject === 'program'
              ? source.program_id
              : subject === 'division'
                ? source.division_id
                : source.offering_id;
          await trx
            .updateTable('capacity_counters')
            .set({ held: sql`held - 1`, version: sql`version + 1` })
            .where('org_id', '=', input.orgId)
            .where('subject_type', '=', subject)
            .where('subject_id', '=', id)
            .where('held', '>', 0)
            .execute();
        }
      }
      if (sameStatus === 'confirmed') {
        for (const subject of ['program', 'division', 'offering'] as const) {
          const id =
            subject === 'program'
              ? destination.program_id
              : subject === 'division'
                ? destination.division_id
                : destination.id;
          const target = await trx
            .selectFrom('capacity_counters')
            .select(['id', 'capacity', 'confirmed'])
            .where('org_id', '=', input.orgId)
            .where('subject_type', '=', subject)
            .where('subject_id', '=', id)
            .forUpdate()
            .executeTakeFirst();
          if (target) {
            if (
              target.capacity !== null &&
              target.confirmed + 1 > target.capacity
            )
              throw new RegistrationCheckoutError(
                409,
                'CAPACITY_FULL',
                'Destination is full',
              );
            await trx
              .updateTable('capacity_counters')
              .set({ confirmed: sql`confirmed + 1`, version: sql`version + 1` })
              .where('org_id', '=', input.orgId)
              .where('id', '=', target.id)
              .execute();
          }
        }
      }
      let invoiceId: string | null = null;
      if (
        input.financialTreatment === 'charge_difference' &&
        difference > 0 &&
        sourceLine &&
        sourceInvoice
      ) {
        invoiceId = newId();
        const number = await allocateOrgNumber(trx, input.orgId, 'invoice');
        await sql`
          INSERT INTO invoices
            (id, org_id, number, account_id, household_id, status, issued_at,
             subtotal_cents, total_cents, source, refund_terms, memo)
          VALUES (${invoiceId}::uuid, ${input.orgId}::uuid, ${number},
            ${sourceInvoice.account_id}::uuid, ${source.household_id}::uuid,
            'open', now(), ${difference}, ${difference}, 'staff',
            ${sourceInvoice.refund_terms ? JSON.stringify(sourceInvoice.refund_terms) : null}::jsonb,
            ${'Registration transfer difference'})
        `.execute(trx);
        await trx
          .insertInto('invoice_lines')
          .values({
            id: newId(),
            org_id: input.orgId,
            invoice_id: invoiceId,
            kind: 'registration',
            description: 'Transfer price difference',
            quantity: 1,
            unit_amount_cents: difference,
            amount_cents: difference,
            refundable: true,
            registration_id: toId,
          })
          .execute();
        // A single due-today installment makes the balance payable through the
        // existing payer installment flow.
        await trx
          .insertInto('installments')
          .values({
            id: newId(),
            org_id: input.orgId,
            invoice_id: invoiceId,
            sequence: 1,
            due_on: this.now().toISOString().slice(0, 10),
            amount_cents: difference,
          })
          .execute();
      }
      await trx
        .insertInto('transfers')
        .values({
          id: newId(),
          org_id: input.orgId,
          from_registration_id: source.id,
          to_registration_id: toId,
          financial_treatment: input.financialTreatment,
          performed_by: this.context.actor.accountId,
          idempotency_key: key,
          request_hash: requestHash,
          result: {
            differenceCents: difference,
            invoiceId,
            ...(refund ? { refund } : {}),
          } as unknown as Json,
        })
        .execute();
      await this.advanceWaitlist(trx, input.orgId, source.offering_id);
      const accountId = await this.payerAccount(trx, source);
      if (accountId) {
        await enqueueRegistrationNotice(trx, this.context, {
          kind: 'registration_transferred',
          sourceId: toId,
          accountId,
          payload: { fromRegistrationId: source.id },
        });
        if (invoiceId)
          await enqueueRegistrationNotice(trx, this.context, {
            kind: 'payment_link',
            sourceId: toId,
            accountId,
            payload: { invoiceId },
          });
      }
      await appendAuditEvent(trx, this.context, {
        action: 'registration.transferred',
        entityType: 'registration',
        entityId: source.id,
        changes: {
          toRegistrationId: { tier: 'internal', after: toId },
          financialTreatment: {
            tier: 'internal',
            after: input.financialTreatment,
          },
          differenceCents: { tier: 'internal', after: difference },
          ...(refund
            ? {
                refund: {
                  tier: 'internal' as const,
                  after: refund,
                },
              }
            : {}),
        },
      });
      return {
        toRegistrationId: toId,
        differenceCents: difference,
        ...(refund
          ? {
              refund: {
                refundId: refund.refundId,
                status: refund.status,
                amountCents: refund.amountCents,
              },
            }
          : {}),
      };
    });
  }
}

export function _internal(): never {
  throw new Error('unused');
}
