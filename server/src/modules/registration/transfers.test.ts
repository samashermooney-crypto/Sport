import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import { allocateOrgNumber } from '../../db/orgCounters.js';
import { createWithOrg } from '../../db/withOrg.js';

import {
  PostgresRegistrationLifecycle,
  registrationTransferResponseSchema,
} from './lifecycle.js';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

async function fixture(destinationPriceCents: number) {
  const orgId = newId();
  const staffAccountId = newId();
  const payerAccountId = newId();
  const personId = newId();
  const householdId = newId();
  const profileId = newId();
  const seasonId = newId();
  const sourceProgramId = newId();
  const sourceDivisionId = newId();
  const sourceOfferingId = newId();
  const destinationProgramId = newId();
  const destinationDivisionId = newId();
  const destinationOfferingId = newId();
  const registrationId = newId();
  const invoiceId = newId();
  const invoiceLineId = newId();
  const context = { orgId, actor: { accountId: staffAccountId } };

  await database
    .insertInto('accounts')
    .values([
      {
        id: staffAccountId,
        email: `transfer-staff-${randomUUID()}@example.invalid`,
        first_name: 'Registrar',
        last_name: 'One',
        date_of_birth: '1990-01-01',
      },
      {
        id: payerAccountId,
        email: `transfer-payer-${randomUUID()}@example.invalid`,
        first_name: 'Family',
        last_name: 'One',
        date_of_birth: '1990-01-01',
      },
    ])
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `registration-transfer-${randomUUID().slice(0, 10)}`,
      name: 'Registration transfer test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();

  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: staffAccountId,
        status: 'active',
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: staffAccountId,
        role: 'registrar',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
    await trx
      .insertInto('sport_profiles')
      .values({
        id: profileId,
        org_id: orgId,
        name: 'Soccer',
        profile: {
          ageGroup: {
            method: 'age_on_date',
            monthDay: '09-01',
            yearBasis: 'season_start',
          },
        },
      })
      .execute();
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: orgId,
        name: '2026 fall',
        starts_on: '2026-09-01',
        ends_on: '2026-12-01',
        status: 'active',
      })
      .execute();
    await trx
      .insertInto('programs')
      .values([
        {
          id: sourceProgramId,
          org_id: orgId,
          season_id: seasonId,
          sport_profile_id: profileId,
          mode: 'league',
          name: 'Source program',
          slug: `source-${randomUUID().slice(0, 8)}`,
          status: 'registration_open',
          visibility: 'public',
          starts_on: '2026-09-01',
          ends_on: '2026-12-01',
        },
        {
          id: destinationProgramId,
          org_id: orgId,
          season_id: seasonId,
          sport_profile_id: profileId,
          mode: 'league',
          name: 'Destination program',
          slug: `destination-${randomUUID().slice(0, 8)}`,
          status: 'registration_open',
          visibility: 'public',
          starts_on: '2026-09-01',
          ends_on: '2026-12-01',
        },
      ])
      .execute();
    await trx
      .insertInto('divisions')
      .values([
        {
          id: sourceDivisionId,
          org_id: orgId,
          program_id: sourceProgramId,
          name: 'Source division',
        },
        {
          id: destinationDivisionId,
          org_id: orgId,
          program_id: destinationProgramId,
          name: 'Destination division',
        },
      ])
      .execute();
    await trx
      .insertInto('registration_offerings')
      .values([
        {
          id: sourceOfferingId,
          org_id: orgId,
          program_id: sourceProgramId,
          division_id: sourceDivisionId,
          name: 'Source offering',
          registrant_role: 'athlete',
          price_cents: 2500,
          visibility: 'public',
          active: true,
          capacity: 10,
        },
        {
          id: destinationOfferingId,
          org_id: orgId,
          program_id: destinationProgramId,
          division_id: destinationDivisionId,
          name: 'Destination offering',
          registrant_role: 'athlete',
          price_cents: destinationPriceCents,
          visibility: 'public',
          active: true,
          capacity: 10,
        },
      ])
      .execute();
    await trx
      .insertInto('capacity_counters')
      .values([
        ...[
          ['program', destinationProgramId],
          ['division', destinationDivisionId],
          ['offering', destinationOfferingId],
        ].map(([subjectType, subjectId]) => ({
          id: newId(),
          org_id: orgId,
          subject_type: subjectType as 'program' | 'division' | 'offering',
          subject_id: subjectId ?? '',
          capacity: 10,
        })),
      ])
      .execute();
    await trx
      .insertInto('people')
      .values({
        id: personId,
        org_id: orgId,
        first_name: 'Maya',
        last_name: 'One',
        date_of_birth: '2012-05-01',
      })
      .execute();
    await trx
      .insertInto('households')
      .values({ id: householdId, org_id: orgId, name: 'One household' })
      .execute();
    await trx
      .insertInto('household_members')
      .values({
        id: newId(),
        org_id: orgId,
        household_id: householdId,
        person_id: personId,
        role: 'athlete',
      })
      .execute();
    await trx
      .insertInto('person_account_links')
      .values({
        id: newId(),
        org_id: orgId,
        person_id: personId,
        account_id: payerAccountId,
        relationship: 'guardian',
        verified_at: new Date(),
      })
      .execute();
    const sourceInvoiceNumber = await allocateOrgNumber(trx, orgId, 'invoice');
    await trx
      .insertInto('invoices')
      .values({
        id: invoiceId,
        org_id: orgId,
        number: sourceInvoiceNumber,
        account_id: payerAccountId,
        household_id: householdId,
        status: 'open',
        issued_at: new Date(),
        subtotal_cents: 2500,
        total_cents: 2500,
        source: 'staff',
      })
      .execute();
    await trx
      .insertInto('registrations')
      .values({
        id: registrationId,
        org_id: orgId,
        program_id: sourceProgramId,
        division_id: sourceDivisionId,
        offering_id: sourceOfferingId,
        person_id: personId,
        household_id: householdId,
        registered_by_account_id: staffAccountId,
        source: 'staff',
        status: 'pending_approval',
      })
      .execute();
    await trx
      .insertInto('invoice_lines')
      .values({
        id: invoiceLineId,
        org_id: orgId,
        invoice_id: invoiceId,
        kind: 'registration',
        description: 'Source registration',
        quantity: 1,
        unit_amount_cents: 2500,
        amount_cents: 2500,
        registration_id: registrationId,
        person_id: personId,
        program_id: sourceProgramId,
        refundable: true,
      })
      .execute();
    await trx
      .updateTable('registrations')
      .set({ invoice_line_id: invoiceLineId })
      .where('org_id', '=', orgId)
      .where('id', '=', registrationId)
      .execute();
  });

  return {
    orgId,
    context,
    registrationId,
    destinationOfferingId,
    payerAccountId,
  };
}

describe('registration transfer money handling', () => {
  it('bills an additional charge to the original payer and replays exactly', async () => {
    const data = await fixture(4000);
    const lifecycle = new PostgresRegistrationLifecycle(database, data.context);
    const request = {
      orgId: data.orgId,
      registrationId: data.registrationId,
      toOfferingId: data.destinationOfferingId,
      financialTreatment: 'charge_difference' as const,
      idempotencyKey: randomUUID(),
    };

    const result = registrationTransferResponseSchema.parse(
      await lifecycle.transfer(request),
    );
    expect(result.differenceCents).toBe(1500);
    expect(await lifecycle.transfer(request)).toEqual(result);
    const invoice = await createWithOrg(database)(data.context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['account_id', 'household_id', 'total_cents', 'memo'])
        .where('org_id', '=', data.orgId)
        .where('memo', '=', 'Registration transfer difference')
        .executeTakeFirstOrThrow(),
    );
    expect(invoice).toMatchObject({
      account_id: data.payerAccountId,
      total_cents: 1500,
      memo: 'Registration transfer difference',
    });
  });

  it('returns a signed no-change difference and blocks an unrecorded refund before mutation', async () => {
    const noChange = await fixture(1500);
    const noChangeLifecycle = new PostgresRegistrationLifecycle(
      database,
      noChange.context,
    );
    const noChangeRequest = {
      orgId: noChange.orgId,
      registrationId: noChange.registrationId,
      toOfferingId: noChange.destinationOfferingId,
      financialTreatment: 'no_change' as const,
      idempotencyKey: randomUUID(),
    };
    const noChangeResult = registrationTransferResponseSchema.parse(
      await noChangeLifecycle.transfer(noChangeRequest),
    );
    expect(noChangeResult.differenceCents).toBe(-1000);
    expect(await noChangeLifecycle.transfer(noChangeRequest)).toEqual(
      noChangeResult,
    );

    const refund = await fixture(1500);
    const refundLifecycle = new PostgresRegistrationLifecycle(
      database,
      refund.context,
    );
    await expect(
      refundLifecycle.transfer({
        orgId: refund.orgId,
        registrationId: refund.registrationId,
        toOfferingId: refund.destinationOfferingId,
        financialTreatment: 'refund_difference',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_TRANSFERABLE', status: 409 });
    const source = await createWithOrg(database)(refund.context, (trx) =>
      trx
        .selectFrom('registrations')
        .select('status')
        .where('org_id', '=', refund.orgId)
        .where('id', '=', refund.registrationId)
        .executeTakeFirstOrThrow(),
    );
    const transfers = await createWithOrg(database)(refund.context, (trx) =>
      trx
        .selectFrom('transfers')
        .select('id')
        .where('org_id', '=', refund.orgId)
        .where('from_registration_id', '=', refund.registrationId)
        .execute(),
    );
    expect(source.status).toBe('pending_approval');
    expect(transfers).toHaveLength(0);
  });
});
