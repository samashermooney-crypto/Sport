import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../../src/db/kysely';
import { createWithOrg, type OrgContext } from '../../../src/db/withOrg';
import { bindFixtureInvoice } from '../../../src/modules/checkout/test-fixtures';
import { PostgresInstallmentTemplates } from '../../../src/modules/finance/installment-templates';
import { PostgresPaymentEventRepository } from '../../../src/modules/finance/payment-event-repo';
import { PostgresPaymentRecordStore } from '../../../src/modules/finance/payment-repo';
import { systemWorkerActorId } from '../../../src/modules/jobs/credentials-expiry';
import {
  createReimbursementRequest,
  createTeamFeeAssessment,
  decideReimbursement,
  getTeamLedger,
  issueTeamFeeAssessment,
  syncPaidTeamFees,
} from '../../../src/modules/team-finance/service';
import { createTestFactories } from '../../factories';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

describe('team finance acceptance flow', () => {
  it('assesses team fees in installments, posts payment to the ledger, and approves a receipt-backed reimbursement', async () => {
    const factories = createTestFactories(database);
    const owner = await factories.actor();
    const program = await factories.program(owner);
    const team = await factories.team(owner, program);
    const householdId = await factories.household(owner);
    const athleteId = await factories.person(owner, {
      firstName: 'Casey',
      lastName: 'Player',
      dateOfBirth: '2014-06-12',
    });
    const registrationId = await factories.registration(
      owner,
      program,
      athleteId,
      householdId,
    );
    const athleteRosterId = newId();
    const requestorPersonId = await factories.person(owner, {
      firstName: 'Morgan',
      lastName: 'Treasurer',
      dateOfBirth: '1988-02-07',
    });
    const receiptFileId = newId();
    const financeAccountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: financeAccountId,
        email: `finance-${randomUUID()}@example.invalid`,
        first_name: 'Club',
        last_name: 'Finance',
        date_of_birth: '1985-03-03',
        email_verified_at: new Date(),
      })
      .execute();
    const financeContext: OrgContext & { accountId: string } = {
      orgId: owner.orgId,
      accountId: financeAccountId,
      actor: { accountId: financeAccountId },
    };
    const withOrg = createWithOrg(database);
    await withOrg(owner, async (trx) => {
      await trx
        .updateTable('registrations')
        .set({ team_season_id: team.teamSeasonId })
        .where('org_id', '=', owner.orgId)
        .where('id', '=', registrationId)
        .execute();
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: owner.orgId,
          household_id: householdId,
          person_id: athleteId,
          role: 'athlete',
          financially_responsible: true,
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: owner.orgId,
          person_id: athleteId,
          account_id: owner.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('roster_entries')
        .values({
          id: athleteRosterId,
          org_id: owner.orgId,
          team_season_id: team.teamSeasonId,
          person_id: athleteId,
          registration_id: registrationId,
          status: 'active',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: owner.orgId,
          person_id: requestorPersonId,
          account_id: owner.accountId,
          relationship: 'self',
        })
        .execute();
      await trx
        .insertInto('team_staff')
        .values({
          id: newId(),
          org_id: owner.orgId,
          team_season_id: team.teamSeasonId,
          person_id: requestorPersonId,
          role: 'treasurer',
          status: 'active',
          added_by: owner.accountId,
        })
        .execute();
      await trx
        .insertInto('files')
        .values({
          id: receiptFileId,
          org_id: owner.orgId,
          purpose: 'document',
          storage_key: `team-finance-receipt/${randomUUID()}`,
          mime: 'application/pdf',
          bytes: 2048,
          sensitivity: 'internal',
          created_by: owner.accountId,
          upload_state: 'complete',
          expires_at: new Date('2030-01-01T00:00:00.000Z'),
        })
        .execute();
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: owner.orgId,
          account_id: financeAccountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: owner.orgId,
          account_id: financeAccountId,
          role: 'finance',
          scope_type: 'org',
          granted_by: owner.accountId,
          pending_mfa: false,
        })
        .execute();
    });

    const template = await new PostgresInstallmentTemplates(
      database,
      owner,
    ).create({
      name: 'Three monthly team installments',
      deposit: { kind: 'fixed', amountCents: 0 },
      schedule: {
        kind: 'fixed_dates',
        dates: ['2027-01-01', '2027-02-01', '2027-03-01'],
      },
      minAmountCents: 15_000,
      autopayRequired: false,
      allowedMethods: ['card'],
    });
    const assessment = await createTeamFeeAssessment(database, owner, {
      teamSeasonId: team.teamSeasonId,
      perPlayerCents: 45_000,
      dueOn: '2027-01-01',
      installmentTemplateId: template.id,
    });
    const issued = await issueTeamFeeAssessment(database, owner, assessment.id);
    expect(issued.issued).toBe(1);
    const invoiceId = issued.invoices[0]?.invoiceId;
    if (!invoiceId) throw new Error('Team fee invoice was not issued');
    const invoiceTerms = await withOrg(owner, async (trx) => ({
      invoice: await trx
        .selectFrom('invoices')
        .select(['total_cents', 'status'])
        .where('org_id', '=', owner.orgId)
        .where('id', '=', invoiceId)
        .executeTakeFirstOrThrow(),
      line: await trx
        .selectFrom('invoice_lines')
        .select(['gl_code', 'team_season_id', 'person_id'])
        .where('org_id', '=', owner.orgId)
        .where('invoice_id', '=', invoiceId)
        .where('kind', '=', 'team_fee')
        .executeTakeFirstOrThrow(),
      installments: await trx
        .selectFrom('installments')
        .select(['id', 'amount_cents', 'paid_cents', 'status'])
        .where('org_id', '=', owner.orgId)
        .where('invoice_id', '=', invoiceId)
        .orderBy('sequence')
        .execute(),
    }));
    expect(invoiceTerms.invoice).toMatchObject({
      total_cents: 45_000,
      status: 'open',
    });
    expect(invoiceTerms.line).toMatchObject({
      gl_code: 'TEAM_FEES',
      team_season_id: team.teamSeasonId,
      person_id: athleteId,
    });
    expect(invoiceTerms.installments.map((item) => item.amount_cents)).toEqual([
      15_000, 15_000, 15_000,
    ]);
    const firstInstallment = invoiceTerms.installments[0];
    if (!firstInstallment)
      throw new Error('First team fee installment was not created');

    const checkoutId = newId();
    await withOrg(owner, (trx) =>
      trx
        .insertInto('checkouts')
        .values({
          id: checkoutId,
          org_id: owner.orgId,
          account_id: owner.accountId,
          status: 'awaiting_payment',
          expires_at: new Date('2027-04-01T00:00:00.000Z'),
          pricing_snapshot: { totalCents: 15_000 },
        })
        .execute(),
    );
    await bindFixtureInvoice(database, owner, checkoutId, invoiceId);
    const paymentIntentId = `pi_${randomUUID()}`;
    await new PostgresPaymentRecordStore(database, owner).recordPending({
      orgId: owner.orgId,
      checkoutId,
      invoiceId,
      accountId: owner.accountId,
      paymentIntentId,
      amountCents: 15_000,
      applicationFeeCents: 0,
      idempotencyKey: randomUUID(),
    });
    await withOrg(owner, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select('id')
        .where('org_id', '=', owner.orgId)
        .where('stripe_payment_intent_id', '=', paymentIntentId)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('payment_allocations')
        .set({ installment_id: firstInstallment.id })
        .where('org_id', '=', owner.orgId)
        .where('payment_id', '=', payment.id)
        .execute();
    });
    await new PostgresPaymentEventRepository(
      database,
      systemWorkerActorId,
    ).applyLatest({
      orgId: owner.orgId,
      paymentIntentId,
      latest: {
        id: paymentIntentId,
        clientSecret: null,
        status: 'succeeded',
        amountCents: 15_000,
        latestChargeId: `ch_${randomUUID()}`,
        method: 'card',
      },
    });
    expect((await syncPaidTeamFees(database, owner.orgId)).created).toBe(1);
    expect((await syncPaidTeamFees(database, owner.orgId)).created).toBe(0);
    const afterPayment = await withOrg(owner, async (trx) => ({
      installment: await trx
        .selectFrom('installments')
        .select(['paid_cents', 'status'])
        .where('org_id', '=', owner.orgId)
        .where('id', '=', firstInstallment.id)
        .executeTakeFirstOrThrow(),
      ledger: await trx
        .selectFrom('team_ledger_entries')
        .select(['direction', 'category', 'amount_cents', 'invoice_line_id'])
        .where('org_id', '=', owner.orgId)
        .where('invoice_id', '=', invoiceId)
        .execute(),
    }));
    expect(afterPayment.installment).toEqual({
      paid_cents: 15_000,
      status: 'paid',
    });
    expect(afterPayment.ledger).toHaveLength(1);
    expect(afterPayment.ledger[0]).toMatchObject({
      direction: 'income',
      category: 'team_fee',
      amount_cents: 15_000,
    });

    const reimbursement = await createReimbursementRequest(database, owner, {
      teamSeasonId: team.teamSeasonId,
      requesterPersonId: requestorPersonId,
      amountCents: 7_500,
      category: 'Travel',
      memo: 'Tournament mileage',
      receiptFileId,
    });
    const approved = await decideReimbursement(
      database,
      financeContext,
      reimbursement.id,
      { decision: 'approve', expectedVersion: reimbursement.version },
    );
    expect(approved.status).toBe('approved');
    expect(
      await getTeamLedger(database, owner, team.teamSeasonId),
    ).toMatchObject({
      incomeCents: 15_000,
      expenseCents: 7_500,
      balanceCents: 7_500,
    });
  });
});
