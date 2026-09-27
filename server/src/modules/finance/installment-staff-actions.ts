import { createHash } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { firstInstallmentAttemptAt } from '@shared/algorithms/dunning-schedule';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

export const installmentStaffActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('change_due_date'),
    expectedVersion: z.number().int().positive(),
    newDueOn: z.iso.date(),
    reason: z.string().trim().min(5).max(500),
  }),
  z.strictObject({
    action: z.literal('split'),
    expectedVersion: z.number().int().positive(),
    splitCents: z.number().int().positive(),
    newDueOn: z.iso.date(),
    reason: z.string().trim().min(5).max(500),
  }),
]);
export const installmentStaffResultSchema = z.strictObject({
  installmentId: z.uuid(),
  version: z.number().int().positive(),
  dueOn: z.iso.date(),
  amountCents: z.number().int().positive(),
  addedInstallmentId: z.uuid().nullable(),
  addedAmountCents: z.number().int().positive().nullable(),
});
export type InstallmentStaffAction = z.output<
  typeof installmentStaffActionSchema
>;
export type InstallmentStaffResult = z.output<
  typeof installmentStaffResultSchema
>;
export class InstallmentStaffConflictError extends Error {}
export class InstallmentStaffNotFoundError extends Error {}

interface InstallmentRow {
  id: string;
  invoice_id: string;
  sequence: number;
  due_on: string;
  amount_cents: number;
  paid_cents: number;
  status: string;
  autopay: boolean;
  payment_method_id: string | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  version: number;
}
interface ReplayRow {
  request_hash: string;
  result: unknown;
}

/** Versioned, keyed schedule edits that never start an off-session charge. */
export class PostgresInstallmentStaffActions {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly now: () => Temporal.Instant = () => Temporal.Now.instant(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async perform(
    installmentId: string,
    operationKey: string,
    value: InstallmentStaffAction,
  ): Promise<InstallmentStaffResult> {
    const input = installmentStaffActionSchema.parse(value);
    const id = z.uuid().parse(installmentId);
    const key = z.uuid().parse(operationKey);
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          installmentId: id,
          actor: this.context.actor.accountId,
          input,
        }),
      )
      .digest('hex');
    return this.withOrg(this.context, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`.execute(trx);
      const replay = await sql<ReplayRow>`
        SELECT request_hash, result FROM installment_staff_actions
        WHERE org_id = ${this.context.orgId}::uuid
          AND operation_key = ${key}::uuid
      `.execute(trx);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== hash)
          throw new InstallmentStaffConflictError('Action key was reused');
        return installmentStaffResultSchema.parse(replay.rows[0].result);
      }
      const rows = await sql<InstallmentRow>`
        SELECT id, invoice_id, sequence, due_on::text, amount_cents,
          paid_cents, status, autopay, payment_method_id,
          attempt_count, next_attempt_at, version
        FROM installments WHERE org_id = ${this.context.orgId}::uuid
          AND id = ${id}::uuid FOR UPDATE
      `.execute(trx);
      const installment = rows.rows[0];
      if (!installment) throw new InstallmentStaffNotFoundError();
      if (installment.version !== input.expectedVersion)
        throw new InstallmentStaffConflictError('Installment version changed');
      const invoice = await trx
        .selectFrom('invoices')
        .select(['status', 'balance_cents', 'disputed_cents'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', installment.invoice_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        !['open', 'partially_paid', 'past_due'].includes(invoice.status) ||
        invoice.balance_cents === null ||
        invoice.balance_cents < 1 ||
        invoice.disputed_cents > 0
      )
        throw new InstallmentStaffConflictError(
          'Invoice cannot be rescheduled',
        );
      if (
        !['scheduled', 'failed'].includes(installment.status) ||
        installment.amount_cents <= installment.paid_cents
      )
        throw new InstallmentStaffConflictError(
          'Installment is not outstanding',
        );
      const pending = await sql<{ exists: boolean }>`
        SELECT EXISTS (SELECT 1 FROM installment_charge_attempts
          WHERE org_id = ${this.context.orgId}::uuid
            AND installment_id = ${id}::uuid
            AND status IN ('reserved', 'external_started')) AS exists
      `.execute(trx);
      if (pending.rows[0]?.exists)
        throw new InstallmentStaffConflictError(
          'Installment charge is in progress',
        );
      const org = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      const today = this.now()
        .toZonedDateTimeISO(org.timezone)
        .toPlainDate()
        .toString();
      if (input.newDueOn <= today)
        throw new InstallmentStaffConflictError(
          'New due date must be in the future',
        );
      let result: InstallmentStaffResult;
      if (input.action === 'change_due_date') {
        const next =
          installment.status === 'failed' &&
          installment.autopay &&
          installment.next_attempt_at
            ? new Date(
                Math.max(
                  Date.parse(
                    firstInstallmentAttemptAt(input.newDueOn, org.timezone),
                  ),
                  installment.next_attempt_at.getTime(),
                ),
              )
            : null;
        await trx
          .updateTable('installments')
          .set({
            due_on: input.newDueOn,
            next_attempt_at: next,
            version: sql`version + 1`,
          })
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', id)
          .execute();
        result = {
          installmentId: id,
          version: installment.version + 1,
          dueOn: input.newDueOn,
          amountCents: installment.amount_cents,
          addedInstallmentId: null,
          addedAmountCents: null,
        };
      } else {
        if (
          installment.status !== 'scheduled' ||
          installment.attempt_count !== 0 ||
          installment.paid_cents !== 0 ||
          input.splitCents >= installment.amount_cents
        )
          throw new InstallmentStaffConflictError(
            'Installment cannot be split',
          );
        const last = await sql<{ sequence: number; due_on: string }>`
          SELECT sequence, due_on::text FROM installments
          WHERE org_id = ${this.context.orgId}::uuid
            AND invoice_id = ${installment.invoice_id}::uuid
          ORDER BY sequence DESC LIMIT 1
        `.execute(trx);
        const final = last.rows[0];
        if (!final || input.newDueOn <= final.due_on)
          throw new InstallmentStaffConflictError(
            'Split date must follow the final installment',
          );
        const addedId = newId();
        await trx
          .updateTable('installments')
          .set({
            amount_cents: installment.amount_cents - input.splitCents,
            version: sql`version + 1`,
          })
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', id)
          .execute();
        await trx
          .insertInto('installments')
          .values({
            id: addedId,
            org_id: this.context.orgId,
            invoice_id: installment.invoice_id,
            sequence: final.sequence + 1,
            due_on: input.newDueOn,
            amount_cents: input.splitCents,
            autopay: false,
            payment_method_id: null,
          })
          .execute();
        result = {
          installmentId: id,
          version: installment.version + 1,
          dueOn: installment.due_on,
          amountCents: installment.amount_cents - input.splitCents,
          addedInstallmentId: addedId,
          addedAmountCents: input.splitCents,
        };
      }
      await sql`
        INSERT INTO installment_staff_actions
          (id, org_id, installment_id, operation_key, request_hash,
           action, result, performed_by, reason)
        VALUES (${newId()}::uuid, ${this.context.orgId}::uuid,
          ${id}::uuid, ${key}::uuid, ${hash}, ${input.action},
          ${JSON.stringify(result)}::jsonb,
          ${this.context.actor.accountId}::uuid, ${input.reason})
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: `installment.${input.action}`,
        entityType: 'installment',
        entityId: id,
        changes: {
          reason: { tier: 'internal', after: input.reason },
          result: { tier: 'internal', after: result },
        },
      });
      return installmentStaffResultSchema.parse(result);
    });
  }
}
