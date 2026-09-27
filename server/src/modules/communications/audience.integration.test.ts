import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { resolveAudience } from './audience';

let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;
const orgId = randomUUID();
const payerAccountId = randomUUID();
const otherGuardianId = randomUUID();
const personId = randomUUID();
const householdId = randomUUID();
const seasonId = randomUUID();
const sportProfileId = randomUUID();
const programId = randomUUID();
const divisionId = randomUUID();
const offeringId = randomUUID();
const teamId = randomUUID();
const teamSeasonId = randomUUID();
const registrationId = randomUUID();
const context: OrgContext = {
  orgId,
  actor: { accountId: payerAccountId },
};

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const [id, firstName] of [
      [payerAccountId, 'Payer'],
      [otherGuardianId, 'Other'],
    ] as const)
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, firstName, 'Guardian', '1985-01-01'],
      );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone) VALUES ($1,$2,$3,$4,$5)',
      [orgId, `audience-${orgId.slice(0, 8)}`, 'Audience Test', 'club', 'UTC'],
    );
    await admin.query(
      'INSERT INTO people(id,org_id,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
      [personId, orgId, 'Riley', 'Athlete', '2015-01-01'],
    );
    await admin.query(
      'INSERT INTO households(id,org_id,name) VALUES ($1,$2,$3)',
      [householdId, orgId, 'Riley household'],
    );
    for (const accountId of [payerAccountId, otherGuardianId])
      await admin.query(
        'INSERT INTO person_account_links(id,org_id,person_id,account_id,relationship,verified_at) VALUES ($1,$2,$3,$4,$5,now())',
        [randomUUID(), orgId, personId, accountId, 'guardian'],
      );
    await admin.query(
      'INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [seasonId, orgId, 'Fall 2026', '2026-08-01', '2026-12-01', 'active'],
    );
    await admin.query(
      'INSERT INTO sport_profiles(id,org_id,name,profile) VALUES ($1,$2,$3,$4::jsonb)',
      [sportProfileId, orgId, 'Soccer', '{}'],
    );
    await admin.query(
      'INSERT INTO programs(id,org_id,season_id,sport_profile_id,mode,name,slug,starts_on,ends_on,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        programId,
        orgId,
        seasonId,
        sportProfileId,
        'league',
        'U10 Soccer',
        `u10-${orgId.slice(0, 8)}`,
        '2026-08-01',
        '2026-12-01',
        'in_progress',
      ],
    );
    await admin.query(
      'INSERT INTO divisions(id,org_id,program_id,name,age_label) VALUES ($1,$2,$3,$4,$5)',
      [divisionId, orgId, programId, 'U10', 'U10'],
    );
    await admin.query(
      'INSERT INTO registration_offerings(id,org_id,program_id,division_id,name,registrant_role,active) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [offeringId, orgId, programId, divisionId, 'Player', 'athlete', true],
    );
    await admin.query(
      'INSERT INTO teams(id,org_id,name,sport_profile_id,age_label) VALUES ($1,$2,$3,$4,$5)',
      [teamId, orgId, 'Rockets', sportProfileId, 'U10'],
    );
    await admin.query(
      'INSERT INTO team_seasons(id,org_id,team_id,program_id,division_id,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [teamSeasonId, orgId, teamId, programId, divisionId, 'active'],
    );
    await admin.query(
      'INSERT INTO registrations(id,org_id,program_id,division_id,offering_id,person_id,household_id,registered_by_account_id,source,status,team_season_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        registrationId,
        orgId,
        programId,
        divisionId,
        offeringId,
        personId,
        householdId,
        payerAccountId,
        'staff',
        'confirmed',
        teamSeasonId,
      ],
    );
    await admin.query(
      'INSERT INTO roster_entries(id,org_id,team_season_id,person_id,registration_id,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), orgId, teamSeasonId, personId, registrationId, 'active'],
    );
    const invoiceId = randomUUID();
    await admin.query('BEGIN');
    await admin.query(
      'INSERT INTO invoices(id,org_id,number,account_id,status,source,subtotal_cents,total_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [invoiceId, orgId, 1, payerAccountId, 'past_due', 'staff', 10000, 10000],
    );
    await admin.query(
      'INSERT INTO invoice_lines(id,org_id,invoice_id,kind,description,unit_amount_cents,amount_cents,registration_id,person_id,program_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        randomUUID(),
        orgId,
        invoiceId,
        'registration',
        'U10 registration',
        10000,
        10000,
        registrationId,
        personId,
        programId,
      ],
    );
    await admin.query('COMMIT');
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

describe('communications audience refinements', () => {
  it('combines team, registration-status and past-due filters while keeping balance details with the bill-to account', async () => {
    const recipients = await resolveAudience(
      context,
      {
        include: { teamSeasonIds: [teamSeasonId] },
        exclude: {},
        filters: {
          registrationStatuses: ['confirmed'],
          pastDueBalance: true,
        },
      },
      new Date('2026-09-27T12:00:00Z'),
      withOrg,
    );

    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({
      accountId: payerAccountId,
      aboutPersonId: personId,
    });
    expect(recipients.map((recipient) => recipient.accountId)).not.toContain(
      otherGuardianId,
    );
  });

  it('removes team members whose registrations do not match the selected status', async () => {
    const recipients = await resolveAudience(
      context,
      {
        include: { teamSeasonIds: [teamSeasonId] },
        exclude: {},
        filters: { registrationStatuses: ['waitlisted'] },
      },
      new Date('2026-09-27T12:00:00Z'),
      withOrg,
    );

    expect(recipients).toEqual([]);
  });
});
