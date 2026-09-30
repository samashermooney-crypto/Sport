import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg, withOrgInTransaction } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { PostgresInvoiceRepository } from '../finance/invoice-repo';

import {
  federationConflict,
  federationNotFound,
  federationUnprocessable,
} from './errors';
import {
  assertActiveRelationship,
  getFederationAdminDatabase,
} from './privileged';

export interface MemberPayerView {
  memberOrgId: string;
  memberOrgName: string;
  billingAccountId: string;
}

export interface FeeAssessmentView {
  id: string;
  memberOrgId: string;
  memberOrgName: string;
  programId: string | null;
  teamEntryId: string | null;
  description: string;
  amountCents: number;
  dueOn: string | null;
  invoiceId: string | null;
  invoiceStatus: string | null;
  balanceCents: number | null;
  status: string;
  createdAt: string;
  version: number;
}

/**
 * Member club names the account that receives league invoices. Privileged
 * write into the LEAGUE org's payer table, gated on an active relationship and
 * on the billing account being an active member of the club org.
 */
export async function setMemberPayer(
  context: OrgContext,
  input: { leagueOrgId: string; billingAccountId: string },
): Promise<MemberPayerView> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await assertActiveRelationship(trx, input.leagueOrgId, context.orgId);
    const member = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', input.billingAccountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!member)
      throw federationUnprocessable(
        'Billing account must be an active member of your organization',
      );
    await trx
      .insertInto('federation_member_payers')
      .values({
        id: newId(),
        org_id: input.leagueOrgId,
        member_org_id: context.orgId,
        billing_account_id: input.billingAccountId,
        created_by: context.actor.accountId,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'member_org_id']).doUpdateSet({
          billing_account_id: input.billingAccountId,
        }),
      )
      .execute();
    const actor = { accountId: context.actor.accountId };
    for (const orgId of [input.leagueOrgId, context.orgId]) {
      await appendAuditEvent(
        trx,
        { orgId, actor },
        {
          action: 'federation.payer.set',
          entityType: 'org_relationship',
          entityId: context.orgId,
          changes: {
            memberOrgId: { tier: 'internal', after: context.orgId },
            leagueOrgId: { tier: 'internal', after: input.leagueOrgId },
          },
        },
      );
    }
    const name = await trx
      .selectFrom('organizations')
      .select('name')
      .where('id', '=', context.orgId)
      .executeTakeFirst();
    return {
      memberOrgId: context.orgId,
      memberOrgName: name?.name ?? 'Member club',
      billingAccountId: input.billingAccountId,
    };
  });
}

export async function listMemberPayers(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<MemberPayerView[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const rows = await trx
      .selectFrom('federation_member_payers')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .execute();
    const orgNames = rows.length
      ? await trx
          .selectFrom('organizations')
          .select(['id', 'name'])
          .where(
            'id',
            'in',
            rows.map((row) => row.member_org_id),
          )
          .execute()
      : [];
    const nameById = new Map(orgNames.map((row) => [row.id, row.name]));
    return rows.map((row) => ({
      memberOrgId: row.member_org_id,
      memberOrgName: nameById.get(row.member_org_id) ?? 'Member club',
      billingAccountId: row.billing_account_id,
    }));
  });
}

function feeView(row: {
  id: string;
  member_org_id: string;
  program_id: string | null;
  team_entry_id: string | null;
  description: string;
  amount_cents: number;
  due_on: Date | string | null;
  invoice_id: string | null;
  status: string;
  created_at: Date;
  version: number;
  member_name?: string | null | undefined;
  invoice_status?: string | null | undefined;
  balance_cents?: number | null | undefined;
}): FeeAssessmentView {
  return {
    id: row.id,
    memberOrgId: row.member_org_id,
    memberOrgName: row.member_name ?? 'Member club',
    programId: row.program_id,
    teamEntryId: row.team_entry_id,
    description: row.description,
    amountCents: row.amount_cents,
    dueOn: row.due_on ? new Date(row.due_on).toISOString().slice(0, 10) : null,
    invoiceId: row.invoice_id,
    invoiceStatus: row.invoice_status ?? null,
    balanceCents: row.balance_cents ?? null,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/** League lists fee assessments with derived invoice status. */
export async function listFeeAssessments(
  database: Kysely<DB>,
  context: OrgContext,
  memberOrgId?: string,
): Promise<FeeAssessmentView[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    let query = trx
      .selectFrom('federation_fee_assessments as f')
      .leftJoin('invoices', (join) =>
        join
          .onRef('invoices.org_id', '=', 'f.org_id')
          .onRef('invoices.id', '=', 'f.invoice_id'),
      )
      .selectAll('f')
      .select(['invoices.status as invoice_status', 'invoices.balance_cents'])
      .orderBy('f.created_at', 'desc')
      .limit(500);
    if (memberOrgId) query = query.where('f.member_org_id', '=', memberOrgId);
    const rows = await query.execute();
    const memberIds = [...new Set(rows.map((row) => row.member_org_id))];
    const orgNames = memberIds.length
      ? await trx
          .selectFrom('organizations')
          .select(['id', 'name'])
          .where('id', 'in', memberIds)
          .execute()
      : [];
    const nameById = new Map(orgNames.map((row) => [row.id, row.name]));
    return rows.map((row) =>
      feeView({ ...row, member_name: nameById.get(row.member_org_id) }),
    );
  });
}

/** League drafts a fee assessment against a member club. */
export async function createFeeAssessment(
  _database: Kysely<DB>,
  context: OrgContext,
  input: {
    memberOrgId: string;
    programId?: string | undefined;
    teamEntryId?: string | undefined;
    description: string;
    amountCents: number;
    dueOn?: string | undefined;
  },
): Promise<FeeAssessmentView> {
  const admin = getFederationAdminDatabase();
  const id = newId();
  return admin.transaction().execute(async (trx) => {
    await assertActiveRelationship(trx, context.orgId, input.memberOrgId);
    if (input.programId) {
      const program = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.programId)
        .executeTakeFirst();
      if (!program) throw federationNotFound('Program not found');
    }
    if (input.teamEntryId) {
      const entry = await trx
        .selectFrom('team_entries')
        .select(['id', 'entrant_org_id'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.teamEntryId)
        .executeTakeFirst();
      if (!entry || entry.entrant_org_id !== input.memberOrgId)
        throw federationNotFound('Team entry not found');
    }
    await trx
      .insertInto('federation_fee_assessments')
      .values({
        id,
        org_id: context.orgId,
        member_org_id: input.memberOrgId,
        program_id: input.programId ?? null,
        team_entry_id: input.teamEntryId ?? null,
        description: input.description,
        amount_cents: input.amountCents,
        due_on: input.dueOn ?? null,
        status: 'draft',
        creation_key: newId(),
        created_by: context.actor.accountId,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.fee.assessed',
      entityType: 'federation_fee_assessment',
      entityId: id,
      changes: {
        memberOrgId: { tier: 'internal', after: input.memberOrgId },
        amountCents: { tier: 'internal', after: input.amountCents },
      },
    });
    const row = await trx
      .selectFrom('federation_fee_assessments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const orgName = await trx
      .selectFrom('organizations')
      .select('name')
      .where('id', '=', input.memberOrgId)
      .executeTakeFirst();
    return feeView({ ...row, member_name: orgName?.name ?? null });
  });
}

/**
 * Issues the finance invoice for a draft assessment. Uses
 * PostgresInvoiceRepository so creation stays idempotent (creation_key) and
 * all finance invariants (totals, numbering, audit) are preserved.
 */
export async function issueFeeInvoice(
  database: Kysely<DB>,
  context: OrgContext,
  assessmentId: string,
): Promise<{ assessmentId: string; invoiceId: string; invoiceNumber: number }> {
  const withOrg = createWithOrg(database);
  const assessment = await withOrg(context, async (trx) => {
    const row = await trx
      .selectFrom('federation_fee_assessments')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', assessmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw federationNotFound('Assessment not found');
    return row;
  });
  if (assessment.status === 'invoiced' && assessment.invoice_id) {
    const issued = await withOrg(context, async (trx) =>
      trx
        .selectFrom('invoices')
        .select('number')
        .where('org_id', '=', context.orgId)
        .where('id', '=', assessment.invoice_id as string)
        .executeTakeFirstOrThrow(),
    );
    return {
      assessmentId,
      invoiceId: assessment.invoice_id,
      invoiceNumber: issued.number,
    };
  }
  if (assessment.status !== 'draft')
    throw federationConflict('Assessment cannot be invoiced');
  const payer = await withOrg(context, async (trx) => {
    const row = await trx
      .selectFrom('federation_member_payers')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('member_org_id', '=', assessment.member_org_id)
      .executeTakeFirst();
    if (!row)
      throw federationUnprocessable(
        'The member club has not set a billing contact',
      );
    return row;
  });
  const repository = new PostgresInvoiceRepository(database, context);
  const invoice = await repository.issue({
    orgId: context.orgId,
    accountId: payer.billing_account_id,
    source: 'team_fee',
    ...(assessment.due_on
      ? { dueOn: new Date(assessment.due_on).toISOString().slice(0, 10) }
      : {}),
    memo: `Federation fee — ${assessment.description}`,
    creationKey: assessment.creation_key,
    lines: [
      {
        kind: 'team_fee',
        description: assessment.description,
        amountCents: assessment.amount_cents,
        refundable: false,
      },
    ],
  });
  await withOrg(context, async (trx) => {
    await trx
      .updateTable('federation_fee_assessments')
      .set({
        status: 'invoiced',
        invoice_id: invoice.id,
        version: sql`version + 1`,
      })
      .where('id', '=', assessmentId)
      .where('status', '=', 'draft')
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.fee.invoiced',
      entityType: 'federation_fee_assessment',
      entityId: assessmentId,
      changes: {
        invoiceId: { tier: 'internal', after: invoice.id },
        invoiceNumber: { tier: 'internal', after: invoice.number },
      },
    });
  });
  return {
    assessmentId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
  };
}

export async function voidFeeAssessment(
  database: Kysely<DB>,
  context: OrgContext,
  assessmentId: string,
  reason: string,
): Promise<{ id: string }> {
  return database.transaction().execute(async (trx) => {
    // The assessment and its finance invoice form one state transition. If the
    // invoice cannot be voided (for example, it has an active installment),
    // roll back the assessment status and its audit event with it.
    const repository = new PostgresInvoiceRepository(database, context);
    const assessment = await withOrgInTransaction(
      trx,
      context,
      async (orgTrx) => {
        const row = await orgTrx
          .selectFrom('federation_fee_assessments')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', assessmentId)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw federationNotFound('Assessment not found');
        if (row.status === 'void')
          throw federationConflict('Assessment already void');
        await orgTrx
          .updateTable('federation_fee_assessments')
          .set({ status: 'void', version: row.version + 1 })
          .where('id', '=', row.id)
          .execute();
        return row;
      },
    );
    if (assessment.invoice_id) {
      await repository.voidInTransaction(trx, {
        orgId: context.orgId,
        invoiceId: assessment.invoice_id,
        reason: `Federation fee assessment voided — ${reason}`,
      });
    }
    return withOrgInTransaction(trx, context, async (orgTrx) => {
      await appendAuditEvent(orgTrx, context, {
        action: 'federation.fee.voided',
        entityType: 'federation_fee_assessment',
        entityId: assessment.id,
        changes: { reason: { tier: 'internal', after: reason } },
      });
      return { id: assessment.id };
    });
  });
}

/**
 * Member club reads its own league fee assessments + invoice status. Privileged
 * read of league-org rows filtered to this club; audited in both orgs.
 */
export async function listClubFees(
  context: OrgContext,
  leagueOrgId: string,
): Promise<FeeAssessmentView[]> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await assertActiveRelationship(trx, leagueOrgId, context.orgId);
    const rows = await trx
      .selectFrom('federation_fee_assessments as f')
      .leftJoin('invoices', (join) =>
        join
          .onRef('invoices.org_id', '=', 'f.org_id')
          .onRef('invoices.id', '=', 'f.invoice_id'),
      )
      .selectAll('f')
      .select(['invoices.status as invoice_status', 'invoices.balance_cents'])
      .where('f.org_id', '=', leagueOrgId)
      .where('f.member_org_id', '=', context.orgId)
      .orderBy('f.created_at', 'desc')
      .execute();
    const leagueName = await trx
      .selectFrom('organizations')
      .select('name')
      .where('id', '=', leagueOrgId)
      .executeTakeFirst();
    const actor = { accountId: context.actor.accountId };
    await appendAuditEvent(
      trx,
      { orgId: leagueOrgId, actor },
      {
        action: 'federation.cross_org.read',
        entityType: 'federation_fee_assessment',
        entityId: context.orgId,
        changes: {
          dataset: { tier: 'internal', after: 'club_fees' },
          requestingOrgId: { tier: 'internal', after: context.orgId },
        },
      },
    );
    await appendAuditEvent(
      trx,
      { orgId: context.orgId, actor },
      {
        action: 'federation.cross_org.read',
        entityType: 'federation_fee_assessment',
        entityId: leagueOrgId,
        changes: {
          dataset: { tier: 'internal', after: 'club_fees' },
          sourceOrgId: { tier: 'internal', after: leagueOrgId },
          count: { tier: 'internal', after: rows.length },
        },
      },
    );
    return rows.map((row) =>
      feeView({ ...row, member_name: leagueName?.name ?? null }),
    );
  });
}
