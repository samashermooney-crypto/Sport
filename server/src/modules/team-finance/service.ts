import { createHash } from 'node:crypto';

import { generateInstallments } from '@shared/algorithms/installments';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import { getDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { PostgresGlCodes } from '../finance/gl-codes';
import { PostgresInstallmentTemplates } from '../finance/installment-templates';
import { PostgresInvoiceRepository } from '../finance/invoice-repo';
import { systemWorkerActorId } from '../jobs/credentials-expiry';

export class TeamFinanceNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}
export class TeamFinanceConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}
export class TeamFinanceAccessError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
}

function dateOnly(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}

function stableUuid(value: string): string {
  const hex = createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '8', 16) & 3) | 8).toString(16);
  const compact = hex.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export async function createTeamFeeAssessment(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    teamSeasonId: string;
    perPlayerCents: number;
    dueOn: string;
    installmentTemplateId?: string | null | undefined;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const team = await trx
      .selectFrom('team_seasons')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.teamSeasonId)
      .where('status', 'in', ['forming', 'active'])
      .executeTakeFirst();
    if (!team) throw new TeamFinanceNotFoundError('Team season not found');
    let ledger = await trx
      .selectFrom('team_ledgers')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', input.teamSeasonId)
      .executeTakeFirst();
    if (!ledger) {
      const created = await trx
        .insertInto('team_ledgers')
        .values({
          org_id: context.orgId,
          team_season_id: input.teamSeasonId,
          created_by: context.actor.accountId,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'team_season_id']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      ledger =
        created ??
        (await trx
          .selectFrom('team_ledgers')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('team_season_id', '=', input.teamSeasonId)
          .executeTakeFirst());
    }
    if (!ledger) throw new Error('Team ledger could not be created');
    const row = await trx
      .insertInto('team_fee_assessments')
      .values({
        org_id: context.orgId,
        team_season_id: input.teamSeasonId,
        per_player_cents: input.perPlayerCents,
        due_on: input.dueOn,
        installment_template_id: input.installmentTemplateId ?? null,
        created_by: context.actor.accountId,
      })
      .returning([
        'id',
        'team_season_id',
        'per_player_cents',
        'due_on',
        'installment_template_id',
        'status',
        'version',
      ])
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'team_fee_assessment.created',
      entityType: 'team_fee_assessment',
      entityId: row.id,
      changes: {
        perPlayerCents: { tier: 'internal', after: input.perPlayerCents },
        teamSeasonId: { tier: 'internal', after: input.teamSeasonId },
      },
    });
    return presentAssessment(row);
  });
}

function presentAssessment(row: {
  id: string;
  team_season_id: string;
  per_player_cents: number;
  due_on: Date | string;
  installment_template_id: string | null;
  status: string;
  version: number;
}) {
  return {
    id: row.id,
    teamSeasonId: row.team_season_id,
    perPlayerCents: row.per_player_cents,
    dueOn: dateOnly(row.due_on),
    installmentTemplateId: row.installment_template_id,
    status: row.status,
    version: row.version,
  };
}

export async function listTeamFeeAssessments(
  database: Kysely<DB>,
  context: OrgContext,
  teamSeasonId: string,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('team_fee_assessments')
      .select([
        'id',
        'team_season_id',
        'per_player_cents',
        'due_on',
        'installment_template_id',
        'status',
        'version',
      ])
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', teamSeasonId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(presentAssessment);
  });
}

export async function issueTeamFeeAssessment(
  database: Kysely<DB>,
  context: OrgContext,
  assessmentId: string,
) {
  const scoped = createWithOrg(database);
  const assessment = await scoped(context, async (trx) =>
    trx
      .selectFrom('team_fee_assessments')
      .select([
        'id',
        'team_season_id',
        'per_player_cents',
        'due_on',
        'installment_template_id',
        'status',
      ])
      .where('org_id', '=', context.orgId)
      .where('id', '=', assessmentId)
      .executeTakeFirst(),
  );
  if (!assessment) throw new TeamFinanceNotFoundError('Assessment not found');
  const existing = await scoped(context, async (trx) =>
    trx
      .selectFrom('team_fee_obligations')
      .innerJoin('invoices', (join) =>
        join
          .onRef('invoices.org_id', '=', 'team_fee_obligations.org_id')
          .onRef('invoices.id', '=', 'team_fee_obligations.invoice_id'),
      )
      .select([
        'team_fee_obligations.person_id',
        'team_fee_obligations.household_id',
        'team_fee_obligations.invoice_id',
        'team_fee_obligations.amount_cents',
      ])
      .where('team_fee_obligations.org_id', '=', context.orgId)
      .where('team_fee_obligations.assessment_id', '=', assessmentId)
      .orderBy('team_fee_obligations.person_id')
      .execute(),
  );
  if (assessment.status === 'issued' || existing.length)
    return {
      assessmentId,
      issued: existing.length,
      invoices: existing.map((row) => ({
        personId: row.person_id,
        householdId: row.household_id,
        invoiceId: row.invoice_id,
        amountCents: row.amount_cents,
      })),
    };
  const roster = await scoped(context, async (trx) =>
    sql<{
      person_id: string;
      household_id: string;
      account_id: string;
    }>`
      SELECT DISTINCT ON (roster.person_id)
        roster.person_id, registration.household_id, link.account_id
      FROM roster_entries roster
      JOIN registrations registration
        ON registration.org_id = roster.org_id
       AND registration.id = roster.registration_id
       AND registration.status = 'confirmed'
      JOIN household_members household_member
        ON household_member.org_id = registration.org_id
       AND household_member.household_id = registration.household_id
       AND household_member.person_id = registration.person_id
       AND household_member.financially_responsible = true
       AND household_member.removed_at IS NULL
      JOIN person_account_links link
        ON link.org_id = household_member.org_id
       AND link.person_id = household_member.person_id
       AND link.relationship = 'guardian'
       AND link.verified_at IS NOT NULL
       AND link.revoked_at IS NULL
      WHERE roster.org_id = ${context.orgId}::uuid
        AND roster.team_season_id = ${assessment.team_season_id}::uuid
        AND roster.status = 'active'
      ORDER BY roster.person_id, link.created_at, link.account_id
    `
      .execute(trx)
      .then((result) => result.rows),
  );
  if (!roster.length)
    throw new TeamFinanceConflictError(
      'No active rostered players have a verified responsible guardian',
    );
  let template:
    | Awaited<ReturnType<PostgresInstallmentTemplates['list']>>[number]
    | undefined;
  if (assessment.installment_template_id) {
    template = (
      await new PostgresInstallmentTemplates(database, context).list(true)
    ).find((item) => item.id === assessment.installment_template_id);
    if (!template)
      throw new TeamFinanceConflictError(
        'Installment template is no longer active',
      );
  }
  const glCodes = new PostgresGlCodes(database, context);
  let feeGlCode = (await glCodes.list()).find(
    (item) => item.code === 'TEAM_FEES',
  );
  if (!feeGlCode) {
    feeGlCode = await glCodes.create(
      { code: 'TEAM_FEES', name: 'Team fees', kind: 'income' },
      stableUuid(`${context.orgId}:team-fees-gl-code`),
    );
  }
  const invoiceRepository = new PostgresInvoiceRepository(database, context);
  const invoices: {
    personId: string;
    householdId: string;
    invoiceId: string;
    amountCents: number;
  }[] = [];
  for (const player of roster) {
    const invoice = await invoiceRepository.issue({
      orgId: context.orgId,
      accountId: player.account_id,
      householdId: player.household_id,
      source: 'team_fee',
      dueOn: dateOnly(assessment.due_on),
      creationKey: stableUuid(`${assessmentId}:${player.person_id}`),
      memo: 'Team fee assessment',
      lines: [
        {
          kind: 'team_fee',
          description: 'Team fee',
          amountCents: assessment.per_player_cents,
          refundable: true,
        },
      ],
    });
    const invoiceLine = await scoped(context, async (trx) => {
      const line = await trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoice.id)
        .where('kind', '=', 'team_fee')
        .executeTakeFirst();
      if (!line) throw new Error('Team fee invoice line was not created');
      await trx
        .updateTable('invoice_lines')
        .set({
          team_season_id: assessment.team_season_id,
          person_id: player.person_id,
          gl_code: feeGlCode.code,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', line.id)
        .execute();
      return line;
    });
    if (template) {
      const plan = generateInstallments(
        assessment.per_player_cents,
        {
          deposit: template.deposit,
          schedule: template.schedule,
          minAmountCents: template.minAmountCents,
        },
        dateOnly(assessment.due_on),
      );
      if (!plan)
        throw new TeamFinanceConflictError(
          'Installment template produces no future payment dates',
        );
      const installments = [
        ...(plan.depositCents > 0
          ? [
              {
                dueOn: dateOnly(assessment.due_on),
                amountCents: plan.depositCents,
              },
            ]
          : []),
        ...plan.installments,
      ];
      await scoped(context, async (trx) => {
        for (const [index, item] of installments.entries()) {
          await trx
            .insertInto('installments')
            .values({
              id: newId(),
              org_id: context.orgId,
              invoice_id: invoice.id,
              sequence: index + 1,
              due_on: item.dueOn,
              amount_cents: item.amountCents,
            })
            .onConflict((oc) =>
              oc.columns(['org_id', 'invoice_id', 'sequence']).doNothing(),
            )
            .execute();
        }
      });
    }
    await scoped(context, async (trx) => {
      await trx
        .insertInto('team_fee_obligations')
        .values({
          org_id: context.orgId,
          assessment_id: assessmentId,
          team_ledger_id: (
            await trx
              .selectFrom('team_ledgers')
              .select('id')
              .where('org_id', '=', context.orgId)
              .where('team_season_id', '=', assessment.team_season_id)
              .executeTakeFirstOrThrow()
          ).id,
          person_id: player.person_id,
          household_id: player.household_id,
          account_id: player.account_id,
          invoice_id: invoice.id,
          invoice_line_id: invoiceLine.id,
          amount_cents: assessment.per_player_cents,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'assessment_id', 'person_id']).doNothing(),
        )
        .execute();
    });
    invoices.push({
      personId: player.person_id,
      householdId: player.household_id,
      invoiceId: invoice.id,
      amountCents: invoice.totalCents,
    });
  }
  await scoped(context, async (trx) => {
    const changed = await trx
      .updateTable('team_fee_assessments')
      .set({ status: 'issued', version: sql`version + 1` })
      .where('org_id', '=', context.orgId)
      .where('id', '=', assessmentId)
      .where('status', '=', 'draft')
      .executeTakeFirst();
    if (changed.numUpdatedRows > 0n)
      await appendAuditEvent(trx, context, {
        action: 'team_fee_assessment.issued',
        entityType: 'team_fee_assessment',
        entityId: assessmentId,
        changes: {
          status: { tier: 'internal', before: 'draft', after: 'issued' },
        },
      });
  });
  return { assessmentId, issued: invoices.length, invoices };
}

export async function getTeamLedger(
  database: Kysely<DB>,
  context: OrgContext,
  teamSeasonId: string,
) {
  return createWithOrg(database)(context, async (trx) => {
    const ledger = await trx
      .selectFrom('team_ledgers')
      .select(['id', 'budget_cents'])
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', teamSeasonId)
      .executeTakeFirst();
    if (!ledger) throw new TeamFinanceNotFoundError('Team ledger not found');
    const rows = await trx
      .selectFrom('team_ledger_entries')
      .select([
        'id',
        'direction',
        'category',
        'amount_cents',
        'occurred_on',
        'memo',
        'source',
        'created_at',
      ])
      .where('org_id', '=', context.orgId)
      .where('team_ledger_id', '=', ledger.id)
      .orderBy('occurred_on', 'desc')
      .orderBy('created_at', 'desc')
      .limit(500)
      .execute();
    const incomeCents = rows
      .filter((row) => row.direction === 'income')
      .reduce((sum, row) => sum + row.amount_cents, 0);
    const expenseCents = rows
      .filter((row) => row.direction === 'expense')
      .reduce((sum, row) => sum + row.amount_cents, 0);
    return {
      teamSeasonId,
      budgetCents: ledger.budget_cents,
      incomeCents,
      expenseCents,
      balanceCents: incomeCents - expenseCents,
      entries: rows.map((row) => ({
        id: row.id,
        direction: row.direction,
        category: row.category,
        amountCents: row.amount_cents,
        occurredOn: dateOnly(row.occurred_on),
        memo: row.memo,
        source: row.source,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });
}

export async function listTeamLedgers(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const result = await sql<{
      team_season_id: string;
      team_name: string;
      program_name: string;
      status: string;
      budget_cents: number;
      income_cents: number;
      expense_cents: number;
      open_reimbursements: number;
      overdue_obligations: number;
    }>`
      SELECT ledger.team_season_id,
        COALESCE(ts.display_name, team.name) AS team_name,
        program.name AS program_name,
        ledger.status, ledger.budget_cents,
        COALESCE(sum(entry.amount_cents) FILTER (WHERE entry.direction = 'income'), 0)::int AS income_cents,
        COALESCE(sum(entry.amount_cents) FILTER (WHERE entry.direction = 'expense'), 0)::int AS expense_cents,
        (SELECT count(*)::int FROM reimbursement_requests r
          WHERE r.org_id = ledger.org_id AND r.team_ledger_id = ledger.id AND r.status = 'submitted') AS open_reimbursements,
        (SELECT count(*)::int FROM team_fee_obligations obligation
          JOIN invoices invoice ON invoice.org_id = obligation.org_id AND invoice.id = obligation.invoice_id
          WHERE obligation.org_id = ledger.org_id AND obligation.team_ledger_id = ledger.id
            AND invoice.balance_cents > 0 AND invoice.due_on < CURRENT_DATE) AS overdue_obligations
      FROM team_ledgers ledger
      JOIN team_seasons ts ON ts.org_id = ledger.org_id AND ts.id = ledger.team_season_id
      JOIN teams team ON team.org_id = ledger.org_id AND team.id = ts.team_id
      JOIN programs program ON program.org_id = ts.org_id AND program.id = ts.program_id
      LEFT JOIN team_ledger_entries entry
        ON entry.org_id = ledger.org_id AND entry.team_ledger_id = ledger.id
      WHERE ledger.org_id = ${context.orgId}::uuid AND ledger.status <> 'archived'
      GROUP BY ledger.id, ledger.team_season_id, team.name, ts.display_name, program.name, ledger.status, ledger.budget_cents
      ORDER BY program.name, team.name
    `.execute(trx);
    return result.rows.map((row) => ({
      teamSeasonId: row.team_season_id,
      teamName: row.team_name,
      programName: row.program_name,
      status: row.status,
      budgetCents: row.budget_cents,
      incomeCents: row.income_cents,
      expenseCents: row.expense_cents,
      balanceCents: row.income_cents - row.expense_cents,
      openReimbursements: row.open_reimbursements,
      overdueObligations: row.overdue_obligations,
    }));
  });
}

export async function createManualLedgerEntry(
  database: Kysely<DB>,
  context: OrgContext,
  teamSeasonId: string,
  input: {
    direction: 'income' | 'expense';
    category: string;
    amountCents: number;
    occurredOn: string;
    memo?: string | null | undefined;
    receiptFileId?: string | null | undefined;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const ledger = await trx
      .selectFrom('team_ledgers')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', teamSeasonId)
      .forUpdate()
      .executeTakeFirst();
    if (!ledger) throw new TeamFinanceNotFoundError('Team ledger not found');
    if (ledger.status !== 'open')
      throw new TeamFinanceConflictError('Team ledger is closed');
    const row = await trx
      .insertInto('team_ledger_entries')
      .values({
        org_id: context.orgId,
        team_ledger_id: ledger.id,
        direction: input.direction,
        category: input.category,
        amount_cents: input.amountCents,
        occurred_on: input.occurredOn,
        memo: input.memo ?? null,
        receipt_file_id: input.receiptFileId ?? null,
        source: 'manual',
        created_by: context.actor.accountId,
        approved_by: context.actor.accountId,
        approved_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'team_ledger_entry.created',
      entityType: 'team_ledger_entry',
      entityId: row.id,
      changes: {
        direction: { tier: 'internal', after: input.direction },
        amountCents: { tier: 'internal', after: input.amountCents },
      },
    });
    return { id: row.id };
  });
}

export async function createReimbursementRequest(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    teamSeasonId: string;
    requesterPersonId: string;
    amountCents: number;
    category: string;
    memo: string;
    receiptFileId: string;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const staff = await trx
      .selectFrom('team_staff')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', input.teamSeasonId)
      .where('person_id', '=', input.requesterPersonId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const self = staff
      ? await trx
          .selectFrom('person_account_links')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('person_id', '=', input.requesterPersonId)
          .where('account_id', '=', context.actor.accountId)
          .where('relationship', '=', 'self')
          .where('revoked_at', 'is', null)
          .executeTakeFirst()
      : null;
    if (!staff || !self)
      throw new TeamFinanceAccessError(
        'Active team staff relationship required',
      );
    const receipt = await trx
      .selectFrom('files')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.receiptFileId)
      .where('created_by', '=', context.actor.accountId)
      .where('upload_state', '=', 'complete')
      .where('deleted_at', 'is', null)
      .where('sensitivity', 'in', ['internal', 'sensitive'])
      .where('mime', 'in', [
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
      ])
      .executeTakeFirst();
    if (!receipt)
      throw new TeamFinanceAccessError(
        'A completed receipt owned by the requester is required',
      );
    const ledger = await trx
      .selectFrom('team_ledgers')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', input.teamSeasonId)
      .executeTakeFirst();
    if (!ledger || ledger.status !== 'open')
      throw new TeamFinanceNotFoundError('Team ledger not found');
    const row = await trx
      .insertInto('reimbursement_requests')
      .values({
        org_id: context.orgId,
        team_ledger_id: ledger.id,
        requester_account_id: context.actor.accountId,
        requester_person_id: input.requesterPersonId,
        amount_cents: input.amountCents,
        category: input.category,
        memo: input.memo,
        receipt_file_id: input.receiptFileId,
      })
      .returning([
        'id',
        'team_ledger_id',
        'requester_account_id',
        'requester_person_id',
        'amount_cents',
        'category',
        'memo',
        'receipt_file_id',
        'status',
        'decision_reason',
        'version',
      ])
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'reimbursement.submitted',
      entityType: 'reimbursement_request',
      entityId: row.id,
      changes: { amountCents: { tier: 'internal', after: row.amount_cents } },
    });
    return presentReimbursement(row, input.teamSeasonId);
  });
}

function presentReimbursement(
  row: {
    id: string;
    requester_account_id: string;
    requester_person_id: string;
    amount_cents: number;
    category: string;
    memo: string;
    receipt_file_id: string;
    status: string;
    decision_reason: string | null;
  },
  teamSeasonId: string,
  version = 1,
) {
  return {
    id: row.id,
    teamSeasonId,
    requesterAccountId: row.requester_account_id,
    requesterPersonId: row.requester_person_id,
    amountCents: row.amount_cents,
    category: row.category,
    memo: row.memo,
    receiptFileId: row.receipt_file_id,
    status: row.status,
    decisionReason: row.decision_reason,
    version,
  };
}

export async function listReimbursementRequests(
  database: Kysely<DB>,
  context: OrgContext,
  teamSeasonId: string,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('reimbursement_requests as request')
      .innerJoin('team_ledgers as ledger', (join) =>
        join
          .onRef('ledger.org_id', '=', 'request.org_id')
          .onRef('ledger.id', '=', 'request.team_ledger_id'),
      )
      .select([
        'request.id',
        'ledger.team_season_id',
        'request.requester_account_id',
        'request.requester_person_id',
        'request.amount_cents',
        'request.category',
        'request.memo',
        'request.receipt_file_id',
        'request.status',
        'request.decision_reason',
        'request.version',
      ])
      .where('request.org_id', '=', context.orgId)
      .where('ledger.team_season_id', '=', teamSeasonId)
      .orderBy('request.created_at', 'desc')
      .execute();
    return rows.map((row) =>
      presentReimbursement(row, row.team_season_id, row.version),
    );
  });
}

export async function decideReimbursement(
  database: Kysely<DB>,
  context: OrgContext,
  reimbursementId: string,
  input: {
    decision: 'approve' | 'reject';
    reason?: string | null | undefined;
    expectedVersion: number;
  },
  now = new Date(),
) {
  return createWithOrg(database)(context, async (trx) => {
    const request = await trx
      .selectFrom('reimbursement_requests as request')
      .innerJoin('team_ledgers as ledger', (join) =>
        join
          .onRef('ledger.org_id', '=', 'request.org_id')
          .onRef('ledger.id', '=', 'request.team_ledger_id'),
      )
      .select([
        'request.id',
        'request.team_ledger_id',
        'ledger.team_season_id',
        'request.requester_account_id',
        'request.requester_person_id',
        'request.amount_cents',
        'request.category',
        'request.memo',
        'request.receipt_file_id',
        'request.status',
        'request.decision_reason',
        'request.version',
      ])
      .where('request.org_id', '=', context.orgId)
      .where('request.id', '=', reimbursementId)
      .forUpdate()
      .executeTakeFirst();
    if (!request)
      throw new TeamFinanceNotFoundError('Reimbursement request not found');
    if (
      request.status !== 'submitted' ||
      request.version !== input.expectedVersion
    )
      throw new TeamFinanceConflictError(
        'Reimbursement request changed or is already decided',
      );
    if (input.decision === 'reject' && !input.reason?.trim())
      throw new RangeError(
        'A reason is required when rejecting a reimbursement',
      );
    let ledgerEntryId: string | null = null;
    if (input.decision === 'approve') {
      ledgerEntryId = newId();
      await trx
        .insertInto('team_ledger_entries')
        .values({
          id: ledgerEntryId,
          org_id: context.orgId,
          team_ledger_id: request.team_ledger_id,
          direction: 'expense',
          category: request.category,
          amount_cents: request.amount_cents,
          occurred_on: dateOnly(now),
          memo: request.memo,
          receipt_file_id: request.receipt_file_id,
          source: 'reimbursement',
          created_by: request.requester_account_id,
          approved_by: context.actor.accountId,
          approved_at: now,
        })
        .execute();
    }
    const nextStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    const updated = await trx
      .updateTable('reimbursement_requests')
      .set({
        status: nextStatus,
        decision_reason: input.reason ?? null,
        decided_by: context.actor.accountId,
        decided_at: now,
        ledger_entry_id: ledgerEntryId,
        version: sql`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', reimbursementId)
      .where('version', '=', input.expectedVersion)
      .returning(['status', 'version', 'decision_reason'])
      .executeTakeFirst();
    if (!updated)
      throw new TeamFinanceConflictError('Reimbursement request changed');
    await appendAuditEvent(trx, context, {
      action: `reimbursement.${nextStatus}`,
      entityType: 'reimbursement_request',
      entityId: reimbursementId,
      changes: {
        status: { tier: 'internal', before: 'submitted', after: nextStatus },
        reason: { tier: 'internal', after: input.reason ?? null },
      },
    });
    return {
      id: request.id,
      teamSeasonId: request.team_season_id,
      requesterAccountId: request.requester_account_id,
      requesterPersonId: request.requester_person_id,
      amountCents: request.amount_cents,
      category: request.category,
      memo: request.memo,
      receiptFileId: request.receipt_file_id,
      status: updated.status,
      decisionReason: updated.decision_reason,
      version: updated.version,
    };
  });
}

export async function syncPaidTeamFees(
  database: Kysely<DB>,
  orgId: string,
  now = new Date(),
) {
  const context: OrgContext = {
    orgId,
    actor: { accountId: systemWorkerActorId },
  };
  return createWithOrg(database)(context, async (trx) => {
    const result = await sql<{
      id: string;
      team_ledger_id: string;
      payment_id: string;
      invoice_id: string;
      invoice_line_id: string;
      amount_cents: number;
      occurred_on: Date;
    }>`
      INSERT INTO team_ledger_entries
        (org_id, team_ledger_id, direction, category, amount_cents, occurred_on,
         memo, source, payment_id, invoice_id, invoice_line_id, created_by,
         approved_by, approved_at)
      SELECT obligation.org_id, obligation.team_ledger_id, 'income', 'team_fee',
        allocation.amount_cents, COALESCE(payment.succeeded_at::date, ${now}::date),
        'Team fee payment', 'team_fee_payment', payment.id, obligation.invoice_id,
        obligation.invoice_line_id, ${systemWorkerActorId}::uuid,
        ${systemWorkerActorId}::uuid, ${now}
      FROM team_fee_obligations obligation
      JOIN payment_allocations allocation
        ON allocation.org_id = obligation.org_id
       AND allocation.invoice_id = obligation.invoice_id
      JOIN payments payment
        ON payment.org_id = allocation.org_id
       AND payment.id = allocation.payment_id
       AND payment.status = 'succeeded'
      WHERE obligation.org_id = ${orgId}::uuid
      ON CONFLICT (org_id, team_ledger_id, invoice_line_id, payment_id)
        WHERE payment_id IS NOT NULL
      DO NOTHING
      RETURNING id, team_ledger_id, payment_id, invoice_id,
        invoice_line_id, amount_cents, occurred_on
    `.execute(trx);
    for (const row of result.rows) {
      await appendAuditEvent(trx, context, {
        action: 'team_ledger_entry.payment_posted',
        entityType: 'team_ledger_entry',
        entityId: row.id,
        changes: {
          amountCents: { tier: 'internal', after: row.amount_cents },
          paymentId: { tier: 'internal', after: row.payment_id },
        },
      });
    }
    return { created: result.rows.length };
  });
}

export async function runTeamFeeLedgerJob(): Promise<{ created: number }> {
  const database = getDatabase();
  const orgs = await database
    .selectFrom('organizations')
    .select('id')
    .execute();
  let created = 0;
  for (const organization of orgs) {
    created += (await syncPaidTeamFees(database, organization.id)).created;
  }
  return { created };
}
