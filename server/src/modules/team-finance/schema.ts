import { z } from 'zod';

const uuid = z.uuid();
export const teamFeeAssessmentBodySchema = z.strictObject({
  teamSeasonId: uuid,
  perPlayerCents: z.number().int().min(1).max(100_000_000),
  dueOn: z.iso.date(),
  installmentTemplateId: uuid.nullable().optional(),
});
export const teamLedgerEntryBodySchema = z.strictObject({
  direction: z.enum(['income', 'expense']),
  category: z.string().trim().min(1).max(80),
  amountCents: z.number().int().min(1).max(100_000_000),
  occurredOn: z.iso.date(),
  memo: z.string().trim().max(2000).nullable().optional(),
  receiptFileId: uuid.nullable().optional(),
});
export const reimbursementBodySchema = z.strictObject({
  teamSeasonId: uuid,
  requesterPersonId: uuid,
  amountCents: z.number().int().min(1).max(100_000_000),
  category: z.string().trim().min(1).max(80),
  memo: z.string().trim().min(1).max(2000),
  receiptFileId: uuid,
});
export const reimbursementDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(2000).nullable().optional(),
  expectedVersion: z.number().int().positive(),
});
export const teamSeasonParamSchema = z.strictObject({ teamSeasonId: uuid });
export const teamFeeAssessmentSchema = teamFeeAssessmentBodySchema.extend({
  id: uuid,
  status: z.enum(['draft', 'issued', 'canceled']),
  version: z.number().int().positive(),
});
export const teamFeeAssessmentListSchema = z.strictObject({
  assessments: z.array(teamFeeAssessmentSchema),
});
export const teamLedgerSchema = z.strictObject({
  teamSeasonId: uuid,
  budgetCents: z.number().int().nonnegative(),
  incomeCents: z.number().int().nonnegative(),
  expenseCents: z.number().int().nonnegative(),
  balanceCents: z.number().int(),
  entries: z.array(
    z.strictObject({
      id: uuid,
      direction: z.enum(['income', 'expense']),
      category: z.string(),
      amountCents: z.number().int().positive(),
      occurredOn: z.iso.date(),
      memo: z.string().nullable(),
      source: z.enum(['team_fee_payment', 'manual', 'reimbursement']),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export const reimbursementSchema = z.strictObject({
  id: uuid,
  teamSeasonId: uuid,
  requesterAccountId: uuid,
  requesterPersonId: uuid,
  amountCents: z.number().int().positive(),
  category: z.string(),
  memo: z.string(),
  receiptFileId: uuid,
  status: z.enum(['submitted', 'approved', 'rejected', 'paid']),
  decisionReason: z.string().nullable(),
  version: z.number().int().positive(),
});
export const reimbursementListSchema = z.strictObject({
  requests: z.array(reimbursementSchema),
});
export const teamFeeIssueResponseSchema = z.strictObject({
  assessmentId: uuid,
  issued: z.number().int().nonnegative(),
  invoices: z.array(
    z.strictObject({
      personId: uuid,
      householdId: uuid,
      invoiceId: uuid,
      amountCents: z.number().int().positive(),
    }),
  ),
});
