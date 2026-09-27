import { createHash } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import { recomputeInvoiceStatus } from './invoice-repo.js';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface IssueRow {
  id: string;
  account_id: string | null;
  household_id: string | null;
  amount_cents: number;
  expires_on: string | null;
  request_hash: string | null;
}

interface DebitRow {
  source_credit_id: string;
  amount_cents: number;
  request_hash: string | null;
  invoice_id: string | null;
}

export class CreditAccessError extends Error {}
export class CreditLedgerConflictError extends Error {}

/** Account credit source balances and invoice applications are serialized in withOrg. */
export class PostgresCreditLedger {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async issue(input: {
    orgId: string;
    accountId?: string;
    householdId?: string;
    amountCents: number;
    source: string;
    expiresOn?: string | null;
    note?: string;
    operationKey: string;
    requireOrgRecipient?: boolean;
  }): Promise<string> {
    this.assertOrg(input.orgId);
    if (
      !uuid.test(input.operationKey) ||
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents < 1
    )
      throw new Error('Credit issuance needs a UUID key and positive cents');
    if (Boolean(input.accountId) === Boolean(input.householdId))
      throw new Error(
        'Credit needs exactly one account or household recipient',
      );
    if (!input.source.trim()) throw new Error('Credit source is required');
    const expiresOn = input.expiresOn
      ? Temporal.PlainDate.from(input.expiresOn).toString()
      : null;
    const requestHash = hash({
      accountId: input.accountId ?? null,
      householdId: input.householdId ?? null,
      amountCents: input.amountCents,
      source: input.source,
      expiresOn,
      note: input.note ?? null,
    });
    return this.withOrg(this.context, async (trx) => {
      const prior = await sql<IssueRow>`
        SELECT id, account_id, household_id, amount_cents,
          expires_on::text, request_hash FROM credits
        WHERE org_id = ${input.orgId}::uuid
          AND operation_key = ${input.operationKey}::uuid
          AND operation_line = 0
      `.execute(trx);
      if (prior.rows[0]) {
        const existing = prior.rows[0];
        if (
          existing.request_hash !== requestHash ||
          existing.account_id !== (input.accountId ?? null) ||
          existing.household_id !== (input.householdId ?? null)
        )
          throw new CreditLedgerConflictError(
            'Credit issuance key conflicts with a different request',
          );
        return existing.id;
      }
      if (input.requireOrgRecipient) {
        if (input.accountId) {
          const access = await sql<{ allowed: boolean }>`
            SELECT EXISTS (
              SELECT 1 FROM person_account_links
              WHERE org_id = ${input.orgId}::uuid
                AND account_id = ${input.accountId}::uuid
                AND revoked_at IS NULL
              UNION ALL
              SELECT 1 FROM org_memberships
              WHERE org_id = ${input.orgId}::uuid
                AND account_id = ${input.accountId}::uuid
                AND status = 'active'
            ) AS allowed
          `.execute(trx);
          if (!access.rows[0]?.allowed)
            throw new CreditAccessError(
              'Credit account is not linked to the organization',
            );
        } else {
          const household = await trx
            .selectFrom('households')
            .select('id')
            .where('org_id', '=', input.orgId)
            .where('id', '=', input.householdId ?? '')
            .where('status', '=', 'active')
            .executeTakeFirst();
          if (!household)
            throw new CreditAccessError('Credit household is unavailable');
        }
      }
      const inserted = await sql<{ id: string }>`
        INSERT INTO credits
          (id, org_id, account_id, household_id, amount_cents, kind, source, expires_on,
           note, created_by, operation_key, operation_line, request_hash)
        VALUES
          (${newId()}::uuid, ${input.orgId}::uuid, ${input.accountId ?? null}::uuid,
           ${input.householdId ?? null}::uuid,
           ${input.amountCents}, 'issued', ${input.source}, ${expiresOn}::date,
           ${input.note ?? null}, ${this.context.actor.accountId}::uuid,
           ${input.operationKey}::uuid, 0, ${requestHash})
        ON CONFLICT DO NOTHING RETURNING id
      `.execute(trx);
      if (inserted.rows[0]) {
        await appendAuditEvent(trx, this.context, {
          action: 'credit.issued',
          entityType: 'credit',
          entityId: inserted.rows[0].id,
          changes: {
            amountCents: { tier: 'internal', after: input.amountCents },
          },
        });
        return inserted.rows[0].id;
      }
      const replay = await sql<IssueRow>`
        SELECT id, account_id, household_id, amount_cents, expires_on::text, request_hash
        FROM credits WHERE org_id = ${input.orgId}::uuid
          AND operation_key = ${input.operationKey}::uuid AND operation_line = 0
      `.execute(trx);
      const row = replay.rows[0];
      if (
        !row ||
        row.request_hash !== requestHash ||
        row.account_id !== (input.accountId ?? null) ||
        row.household_id !== (input.householdId ?? null)
      )
        throw new CreditLedgerConflictError(
          'Credit issuance key conflicts with a different request',
        );
      return row.id;
    });
  }

  async apply(input: {
    orgId: string;
    accountId?: string;
    householdId?: string;
    invoiceId: string;
    amountCents: number;
    todayLocal?: string;
    operationKey: string;
    payerAccountId?: string;
  }): Promise<void> {
    this.assertOrg(input.orgId);
    if (
      !uuid.test(input.operationKey) ||
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents < 1
    )
      throw new Error('Credit application needs a UUID key and positive cents');
    if (Boolean(input.accountId) === Boolean(input.householdId))
      throw new Error(
        'Credit needs exactly one account or household recipient',
      );
    const providedToday = input.todayLocal
      ? Temporal.PlainDate.from(input.todayLocal).toString()
      : null;
    const requestHash = hash({
      accountId: input.accountId ?? null,
      householdId: input.householdId ?? null,
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
    });
    await this.withOrg(this.context, async (trx) => {
      if (input.payerAccountId) {
        if (input.payerAccountId !== this.context.actor.accountId)
          throw new CreditAccessError('Payer actor mismatch');
        if (input.accountId) {
          if (input.accountId !== input.payerAccountId)
            throw new CreditAccessError(
              'Account credit belongs to another payer',
            );
        } else {
          const access = await sql<{ id: string }>`
            SELECT pal.id FROM households h
            JOIN household_members hm ON hm.org_id = h.org_id
              AND hm.household_id = h.id
            JOIN person_account_links pal ON pal.org_id = hm.org_id
              AND pal.person_id = hm.person_id
            WHERE h.org_id = ${input.orgId}::uuid
              AND h.id = ${input.householdId ?? null}::uuid
              AND h.status = 'active'
              AND hm.removed_at IS NULL
              AND hm.financially_responsible = true
              AND hm.role IN ('guardian', 'other_adult')
              AND pal.account_id = ${input.payerAccountId}::uuid
              AND pal.relationship = 'self'
              AND pal.revoked_at IS NULL
            FOR SHARE OF h, hm, pal
          `.execute(trx);
          if (!access.rows.length)
            throw new CreditAccessError(
              'Household credit belongs to another payer',
            );
        }
      }
      await sql`SELECT pg_advisory_xact_lock(hashtext(${input.operationKey}))`.execute(
        trx,
      );
      const replay = await sql<DebitRow>`
        SELECT source_credit_id, amount_cents, request_hash, invoice_id
        FROM credits WHERE org_id = ${input.orgId}::uuid
          AND operation_key = ${input.operationKey}::uuid ORDER BY operation_line
      `.execute(trx);
      if (replay.rows.length) {
        if (
          replay.rows.some(
            (row) =>
              row.request_hash !== requestHash ||
              row.invoice_id !== input.invoiceId,
          ) ||
          -replay.rows.reduce((sum, row) => sum + row.amount_cents, 0) !==
            input.amountCents
        )
          throw new CreditLedgerConflictError(
            'Credit application key conflicts with a different request',
          );
        return;
      }
      const todayLocal =
        providedToday ??
        (await (async () => {
          const clock = await sql<{ timezone: string; instant: Date }>`
          SELECT timezone, transaction_timestamp() AS instant
          FROM organizations WHERE id = ${input.orgId}::uuid
        `.execute(trx);
          const row = clock.rows[0];
          if (!row)
            throw new CreditLedgerConflictError(
              'Credit organization unavailable',
            );
          return Temporal.Instant.from(row.instant.toISOString())
            .toZonedDateTimeISO(row.timezone)
            .toPlainDate()
            .toString();
        })());
      const invoice = await trx
        .selectFrom('invoices')
        .select([
          'account_id',
          'household_id',
          'balance_cents',
          'disputed_cents',
          'status',
        ])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.invoiceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !invoice ||
        (input.accountId
          ? invoice.account_id !== input.accountId
          : invoice.household_id !== input.householdId) ||
        invoice.balance_cents === null ||
        input.amountCents > invoice.balance_cents ||
        invoice.disputed_cents > 0 ||
        invoice.status === 'draft' ||
        invoice.status === 'void'
      )
        throw new CreditLedgerConflictError(
          'Invoice cannot accept this credit',
        );
      const unsettled = await sql<{ id: string }>`
        SELECT p.id FROM payment_allocations pa
        JOIN payments p ON p.org_id = pa.org_id AND p.id = pa.payment_id
        WHERE pa.org_id = ${input.orgId}::uuid
          AND pa.invoice_id = ${input.invoiceId}::uuid
          AND p.status IN ('requires_action', 'processing')
        LIMIT 1
      `.execute(trx);
      if (unsettled.rows.length)
        throw new CreditLedgerConflictError('Invoice has an unsettled payment');
      const issues = await sql<IssueRow>`
        SELECT id, account_id, household_id, amount_cents, expires_on::text, request_hash
        FROM credits
        WHERE org_id = ${input.orgId}::uuid
          AND account_id IS NOT DISTINCT FROM ${input.accountId ?? null}::uuid
          AND household_id IS NOT DISTINCT FROM ${input.householdId ?? null}::uuid
          AND kind = 'issued'
          AND (expires_on IS NULL OR expires_on >= ${todayLocal}::date)
        ORDER BY created_at, id FOR UPDATE
      `.execute(trx);
      let remaining = input.amountCents;
      let line = 0;
      for (const issue of issues.rows) {
        const used = await sql<{ spent: number }>`
          SELECT coalesce(-sum(amount_cents), 0)::bigint AS spent
          FROM credits WHERE org_id = ${input.orgId}::uuid
            AND source_credit_id = ${issue.id}::uuid
        `.execute(trx);
        const available = issue.amount_cents - (used.rows[0]?.spent ?? 0);
        if (available < 0) throw new Error('Credit source is overdrawn');
        const take = Math.min(available, remaining);
        if (take === 0) continue;
        await sql`
          INSERT INTO credits
            (id, org_id, account_id, household_id, amount_cents, kind, source, invoice_id,
             created_by, source_credit_id, operation_key, operation_line, request_hash)
          VALUES
            (${newId()}::uuid, ${input.orgId}::uuid, ${input.accountId ?? null}::uuid,
             ${input.householdId ?? null}::uuid,
             ${-take}, 'applied', 'invoice', ${input.invoiceId}::uuid,
             ${this.context.actor.accountId}::uuid, ${issue.id}::uuid,
             ${input.operationKey}::uuid, ${line}, ${requestHash})
        `.execute(trx);
        remaining -= take;
        line += 1;
        if (remaining === 0) break;
      }
      if (remaining !== 0)
        throw new CreditLedgerConflictError(
          'Insufficient unexpired credit balance',
        );
      await trx
        .updateTable('invoices')
        .set({
          credit_applied_cents: sql`credit_applied_cents + ${input.amountCents}`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.invoiceId)
        .execute();
      await recomputeInvoiceStatus(
        trx,
        input.orgId,
        input.invoiceId,
        todayLocal,
      );
      await appendAuditEvent(trx, this.context, {
        action: 'credit.applied',
        entityType: 'invoice',
        entityId: input.invoiceId,
        changes: {
          amountCents: { tier: 'internal', after: input.amountCents },
        },
      });
    });
  }

  async expire(input: {
    orgId: string;
    sourceCreditId: string;
    todayLocal: string;
  }): Promise<number> {
    this.assertOrg(input.orgId);
    const todayLocal = Temporal.PlainDate.from(input.todayLocal).toString();
    return this.withOrg(this.context, async (trx) => {
      const issue = await sql<IssueRow>`
        SELECT id, account_id, household_id, amount_cents, expires_on::text, request_hash
        FROM credits WHERE org_id = ${input.orgId}::uuid
          AND id = ${input.sourceCreditId}::uuid AND kind = 'issued'
        FOR UPDATE
      `.execute(trx);
      const row = issue.rows[0];
      if (!row) throw new Error('Credit source not found');
      if (!row.expires_on || row.expires_on >= todayLocal) return 0;
      const used = await sql<{ spent: number }>`
        SELECT coalesce(-sum(amount_cents), 0)::bigint AS spent
        FROM credits WHERE org_id = ${input.orgId}::uuid
          AND source_credit_id = ${row.id}::uuid
      `.execute(trx);
      const remaining = row.amount_cents - (used.rows[0]?.spent ?? 0);
      if (remaining < 0) throw new Error('Credit source is overdrawn');
      if (remaining === 0) return 0;
      await sql`
        INSERT INTO credits
          (id, org_id, account_id, household_id, amount_cents, kind, source, created_by, source_credit_id)
        VALUES
          (${newId()}::uuid, ${input.orgId}::uuid, ${row.account_id}::uuid,
           ${row.household_id}::uuid,
           ${-remaining}, 'expired', 'expiry', ${this.context.actor.accountId}::uuid,
           ${row.id}::uuid)
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'credit.expired',
        entityType: 'credit',
        entityId: row.id,
        changes: { amountCents: { tier: 'internal', after: remaining } },
      });
      return remaining;
    });
  }

  async reverseUnused(input: {
    orgId: string;
    sourceCreditId: string;
    reason: string;
    operationKey: string;
  }): Promise<number> {
    this.assertOrg(input.orgId);
    if (!uuid.test(input.operationKey) || !input.reason.trim())
      throw new Error('Credit reversal needs a UUID key and reason');
    const requestHash = hash({
      sourceCreditId: input.sourceCreditId,
      reason: input.reason,
    });
    return this.withOrg(this.context, async (trx) => {
      const issue = await sql<IssueRow>`
        SELECT id, account_id, household_id, amount_cents, expires_on::text, request_hash
        FROM credits WHERE org_id = ${input.orgId}::uuid
          AND id = ${input.sourceCreditId}::uuid AND kind = 'issued'
        FOR UPDATE
      `.execute(trx);
      const row = issue.rows[0];
      if (!row) throw new Error('Credit source not found');
      const replay = await sql<{
        amount_cents: number;
        request_hash: string | null;
        source_credit_id: string | null;
      }>`
        SELECT amount_cents, request_hash, source_credit_id FROM credits
        WHERE org_id = ${input.orgId}::uuid
          AND operation_key = ${input.operationKey}::uuid AND operation_line = 0
      `.execute(trx);
      if (replay.rows[0]) {
        if (
          replay.rows[0].request_hash !== requestHash ||
          replay.rows[0].source_credit_id !== row.id
        )
          throw new Error(
            'Credit reversal key conflicts with a different request',
          );
        return -replay.rows[0].amount_cents;
      }
      const used = await sql<{ spent: number }>`
        SELECT coalesce(-sum(amount_cents), 0)::bigint AS spent
        FROM credits WHERE org_id = ${input.orgId}::uuid
          AND source_credit_id = ${row.id}::uuid
      `.execute(trx);
      const remaining = row.amount_cents - (used.rows[0]?.spent ?? 0);
      if (remaining < 0) throw new Error('Credit source is overdrawn');
      if (remaining === 0) return 0;
      await sql`
        INSERT INTO credits
          (id, org_id, account_id, household_id, amount_cents, kind, source,
           note, created_by, source_credit_id, operation_key, operation_line, request_hash)
        VALUES
          (${newId()}::uuid, ${input.orgId}::uuid, ${row.account_id}::uuid,
           ${row.household_id}::uuid, ${-remaining}, 'reversed', 'staff',
           ${input.reason}, ${this.context.actor.accountId}::uuid, ${row.id}::uuid,
           ${input.operationKey}::uuid, 0, ${requestHash})
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'credit.reversed',
        entityType: 'credit',
        entityId: row.id,
        changes: {
          amountCents: { tier: 'internal', after: remaining },
          reason: { tier: 'internal', after: input.reason },
        },
      });
      return remaining;
    });
  }

  async balance(input: {
    orgId: string;
    accountId?: string;
    householdId?: string;
    todayLocal: string;
  }): Promise<number> {
    this.assertOrg(input.orgId);
    if (Boolean(input.accountId) === Boolean(input.householdId))
      throw new Error(
        'Credit needs exactly one account or household recipient',
      );
    const todayLocal = Temporal.PlainDate.from(input.todayLocal).toString();
    return this.withOrg(this.context, async (trx) => {
      const sources = await sql<{ remaining: number }>`
        SELECT issue.amount_cents + coalesce(sum(debit.amount_cents), 0)::bigint AS remaining
        FROM credits issue
        LEFT JOIN credits debit ON debit.org_id = issue.org_id
          AND debit.source_credit_id = issue.id
        WHERE issue.org_id = ${input.orgId}::uuid AND issue.kind = 'issued'
          AND issue.account_id IS NOT DISTINCT FROM ${input.accountId ?? null}::uuid
          AND issue.household_id IS NOT DISTINCT FROM ${input.householdId ?? null}::uuid
          AND (issue.expires_on IS NULL OR issue.expires_on >= ${todayLocal}::date)
        GROUP BY issue.id
      `.execute(trx);
      const total = sources.rows.reduce(
        (sum, source) => sum + source.remaining,
        0,
      );
      if (!Number.isSafeInteger(total) || total < 0)
        throw new Error('Credit balance does not reconcile');
      return total;
    });
  }

  private assertOrg(orgId: string): void {
    if (orgId !== this.context.orgId)
      throw new Error('Credit organization mismatch');
  }
}
