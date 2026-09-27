import { newId } from '@shared/ids';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DB } from '../src/db/types';
import { MemoryStorage } from '../src/integrations/storage/storage';
import { createImportsService } from '../src/modules/imports/service';
import type { ImportsService } from '../src/modules/imports/service';

import { createTestFactories } from './factories';
import type { ActorFixture } from './factories';

const { Pool } = pg;

let database: Kysely<DB>;
let factories: ReturnType<typeof createTestFactories>;
let service: ImportsService;
let actor: ActorFixture;
let outsider: ActorFixture;

function query<T>(
  as: ActorFixture,
  run: (
    trx: Parameters<Parameters<typeof factories.scoped>[1]>[0],
  ) => Promise<T>,
): Promise<T> {
  return factories.scoped(as, run);
}

beforeAll(async () => {
  database = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString:
          process.env.TEST_DATABASE_APP_URL ?? process.env.TEST_DATABASE_URL,
      }),
    }),
  });
  factories = createTestFactories(database);
  service = createImportsService(database, null, new MemoryStorage());
  actor = await factories.actor();
  outsider = await factories.actor();
  await factories.scoped(actor, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .execute();
  });
});

afterAll(async () => {
  await database.destroy();
});

async function uploadAndValidate(
  kind: string,
  fileName: string,
  content: string,
  asActor: ActorFixture = actor,
) {
  const batch = await service.createBatch(asActor.orgId, asActor.accountId, {
    kind: kind as never,
    fileName,
    bytes: new TextEncoder().encode(content),
  });
  await service.validateBatch(asActor.orgId, batch.id, asActor.accountId);
  return batch;
}

describe('imports service', () => {
  it('creates a batch, detects headers, and reports required gaps', async () => {
    const batch = await service.createBatch(actor.orgId, actor.accountId, {
      kind: 'people',
      fileName: 'members.csv',
      bytes: new TextEncoder().encode(
        'First Name,Last Name,Email,Role\nAlex,Rivera,alex@example.test,guardian\n',
      ),
    });
    expect(batch.rowCount).toBe(1);
    expect(batch.mapping?.columns['First Name']).toBe('first_name');
    expect(batch.mapping?.columns['Last Name']).toBe('last_name');
    expect(batch.mapping?.columns['Email']).toBe('email');
    expect(batch.status).toBe('uploaded');
  });

  it('rejects mapping that misses required fields', async () => {
    const batch = await service.createBatch(actor.orgId, actor.accountId, {
      kind: 'people',
      fileName: 'bad.csv',
      bytes: new TextEncoder().encode('Nickname,Email\nAl,a@example.test\n'),
    });
    await expect(
      service.setMapping(
        actor.orgId,
        actor.accountId,
        batch.id,
        {
          columns: { Nickname: 'preferred_name', Email: 'email' },
        },
        undefined,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('validates and commits a people import with household grouping', async () => {
    const batch = await uploadAndValidate(
      'people',
      'members.csv',
      [
        'First Name,Last Name,Email,Phone,Household,Household Role,Date of Birth,Emergency Contact,Emergency Phone,Emergency Note',
        'Alex,Rivera,alex.r@example.test,555-010-0134,Rivera,guardian,1990-01-01,,,',
        'Sam,Rivera,sam.r@example.test,,Rivera,guardian,1988-06-02,,,',
        'Jordan,Rivera,,,Rivera,athlete,2016-03-12,Alex Rivera,555-010-0134,Mom',
      ].join('\n'),
    );
    const after = await service.getBatch(
      actor.orgId,
      actor.accountId,
      batch.id,
    );
    expect(after.status).toBe('validated');
    expect(after.errorCount).toBe(0);
    const rows = await service.listRows(
      actor.orgId,
      actor.accountId,
      batch.id,
      {
        limit: 50,
        filter: 'all',
      },
    );
    expect(rows.items).toHaveLength(3);
    expect(
      rows.items.every((row) => !row.issues.some((i) => i.level === 'error')),
    ).toBe(true);
    const summary = await service.commitBatch(
      actor.orgId,
      batch.id,
      actor.accountId,
    );
    expect(summary['committed']).toBe(3);
    const people = await query(actor, (trx) =>
      trx
        .selectFrom('people')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(people.length).toBeGreaterThanOrEqual(3);
    const jordan = people.find((p) => p.first_name === 'Jordan');
    expect(jordan).toBeTruthy();
    const members = await query(actor, (trx) =>
      trx
        .selectFrom('household_members')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(members).toHaveLength(3);
    const households = await query(actor, (trx) =>
      trx
        .selectFrom('households')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(households).toHaveLength(1);
    const contacts = await query(actor, (trx) =>
      trx
        .selectFrom('emergency_contacts')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(contacts).toHaveLength(1);
    const rollback = await service.rollbackBatch(
      actor.orgId,
      batch.id,
      actor.accountId,
    );
    expect((rollback['deleted'] as Record<string, number>)['people']).toBe(3);
    const remaining = await query(actor, (trx) =>
      trx
        .selectFrom('people')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(remaining.filter((p) => p.first_name === 'Jordan')).toHaveLength(0);
  });

  it('enforces kind-scoped roles and tenancy', async () => {
    await expect(
      service.createBatch(outsider.orgId, outsider.accountId, {
        kind: 'people',
        fileName: 'x.csv',
        bytes: new TextEncoder().encode('a,b\n1,2\n'),
      }),
    ).rejects.toMatchObject({ status: 404 });
    const batch = await service.createBatch(actor.orgId, actor.accountId, {
      kind: 'people',
      fileName: 'x.csv',
      bytes: new TextEncoder().encode(
        'First Name,Last Name,Email,Role\nA,B,a@example.test,guardian\n',
      ),
    });
    await expect(
      service.getBatch(outsider.orgId, outsider.accountId, batch.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('imports historical payments as external, reporting-only records', async () => {
    const fixture = await factories.program(actor);
    expect(fixture.programId).toBeTruthy();
    const batch = await uploadAndValidate(
      'historical_payments',
      'payments.csv',
      [
        'First Name,Last Name,Email,Amount,Paid On,Description,Method,Status,Reference',
        'Alex,Rivera,alex.r@example.test,149.00,2025-08-15,Fall registration,card,paid,OLD-1042',
      ].join('\n'),
    );
    const after = await service.getBatch(
      actor.orgId,
      actor.accountId,
      batch.id,
    );
    expect(after.status).toBe('validated');
    const summary = await service.commitBatch(
      actor.orgId,
      batch.id,
      actor.accountId,
    );
    expect(summary['committed']).toBe(1);
    const payments = await query(actor, (trx) =>
      trx
        .selectFrom('payments')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]?.method).toBe('external');
    expect(payments[0]?.stripe_payment_intent_id).toBeNull();
    expect(payments[0]?.stripe_charge_id).toBeNull();
    expect(payments[0]?.status).toBe('succeeded');
  });

  it('imports teams, rosters and schedules end-to-end', async () => {
    await factories.program(actor);
    const teamsBatch = await uploadAndValidate(
      'teams',
      'teams.csv',
      [
        'Team,Division,Program,Coach First,Coach Last,Coach Email,Coach Phone,Coach Role,Roster Cap',
        'Falcons,Open,Fixture League,Sam,Carter,sam.c@example.test,555-0101,head_coach,14',
      ].join('\n'),
    );
    const teams = await service.commitBatch(
      actor.orgId,
      teamsBatch.id,
      actor.accountId,
    );
    expect(teams['committed']).toBe(1);

    const rosterBatch = await uploadAndValidate(
      'rosters',
      'roster.csv',
      [
        'Team,Program,Player First,Player Last,Player Email,Player DOB,Jersey,Status,Guardian First,Guardian Email',
        'Falcons,Fixture League,Jordan,Rivera,jordan.r@example.test,2016-03-12,12,active,Alex,alex.r@example.test',
      ].join('\n'),
    );
    const roster = await service.commitBatch(
      actor.orgId,
      rosterBatch.id,
      actor.accountId,
    );
    expect(roster['committed']).toBe(1);
    const entries = await query(actor, (trx) =>
      trx
        .selectFrom('roster_entries')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jersey_number).toBe('12');

    const scheduleBatch = await uploadAndValidate(
      'schedule',
      'schedule.csv',
      [
        'Title,Home Team,Away Team,Event Type,Program,Start Date,End Date,Date,Start Time,End Time,Space,Facility,Address,City,State,Zip,Notes',
        'Falcons vs Wolves,Falcons,Wolves,game,Fixture League,2026-04-11,2026-04-11,2026-04-11,15:00,16:00,Field 1,Riverside Park,203 River Rd,Denver,CO,80205,',
      ].join('\n'),
    );
    const schedule = await service.commitBatch(
      actor.orgId,
      scheduleBatch.id,
      actor.accountId,
    );
    expect(schedule['committed']).toBe(1);
    const events = await query(actor, (trx) =>
      trx
        .selectFrom('events')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(events).toHaveLength(1);
  });

  it('imports registration history rows', async () => {
    await factories.program(actor);
    const personId = await factories.person(actor, {
      firstName: 'Registered',
      lastName: 'Kid',
    });
    await query(actor, (trx) =>
      trx
        .updateTable('people')
        .set({ email: 'reg.kid@example.test' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', personId)
        .execute(),
    );
    const batch = await uploadAndValidate(
      'registrations',
      'registrations.csv',
      [
        'Participant email,Participant first name,Participant last name,Participant date of birth,Program,Division,Offering,Status,Team,Registered on',
        'reg.kid@example.test,Registered,Kid,2012-01-01,Fixture League,Open,Player,confirmed,,2025-08-01',
      ].join('\n'),
    );
    const after = await service.getBatch(
      actor.orgId,
      actor.accountId,
      batch.id,
    );
    expect(after.errorCount).toBe(0);
    const summary = await service.commitBatch(
      actor.orgId,
      batch.id,
      actor.accountId,
    );
    expect(summary['committed']).toBe(1);
    const registrations = await query(actor, (trx) =>
      trx
        .selectFrom('registrations')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.status).toBe('confirmed');
  });

  it('imports credentials and volunteer hours', async () => {
    const personId = await factories.person(actor, {
      firstName: 'Coach',
      lastName: 'One',
    });
    await query(actor, (trx) =>
      trx
        .updateTable('people')
        .set({ email: 'coach.one@example.test' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', personId)
        .execute(),
    );
    const credBatch = await uploadAndValidate(
      'credentials',
      'credentials.csv',
      [
        'First Name,Last Name,Email,Credential Type,Status,Expires On,Issuer,Document File,Identifier,Issued On,Notes',
        'Coach,One,coach.one@example.test,Background Check,clear,2027-09-01,Sterling,,,2025-09-01,',
      ].join('\n'),
    );
    const credResult = await service.commitBatch(
      actor.orgId,
      credBatch.id,
      actor.accountId,
    );
    expect(credResult['committed']).toBe(1);
    const creds = await query(actor, (trx) =>
      trx
        .selectFrom('person_credentials')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(creds).toHaveLength(1);

    const hoursBatch = await uploadAndValidate(
      'volunteer_hours',
      'hours.csv',
      [
        'First Name,Last Name,Email,Role,Event,Date,Hours,Status,Notes',
        'Coach,One,coach.one@example.test,Field marshal,Opening day,2026-03-14,3.5,approved,',
      ].join('\n'),
    );
    const hoursResult = await service.commitBatch(
      actor.orgId,
      hoursBatch.id,
      actor.accountId,
    );
    expect(hoursResult['committed']).toBe(1);
    const signups = await query(actor, (trx) =>
      trx
        .selectFrom('volunteer_signups')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(signups).toHaveLength(1);
    expect(Number(signups[0]?.hours_credited)).toBeCloseTo(3.5);
  });

  it('flags duplicates and applies skip/update decisions', async () => {
    const existing = newId();
    await query(actor, (trx) =>
      trx
        .insertInto('people')
        .values({
          id: existing,
          org_id: actor.orgId,
          first_name: 'Dupe',
          last_name: 'Person',
          email: 'dupe@example.test',
          date_of_birth: '1990-01-01',
        })
        .execute(),
    );
    const batch = await uploadAndValidate(
      'people',
      'dupe.csv',
      'First Name,Last Name,Email,Role\nDupe,Person,dupe@example.test,guardian\n',
    );
    const rows = await service.listRows(
      actor.orgId,
      actor.accountId,
      batch.id,
      {
        limit: 10,
        filter: 'all',
      },
    );
    expect(rows.items[0]?.duplicates.length).toBeGreaterThan(0);
    expect(rows.items[0]?.action).toBe('skip');
    await service.decideRows(actor.orgId, actor.accountId, batch.id, [
      { rowId: rows.items[0]?.id ?? '', action: 'update', targetId: existing },
    ]);
    const summary = await service.commitBatch(
      actor.orgId,
      batch.id,
      actor.accountId,
    );
    expect(summary['updated']).toBe(1);
    const still = await query(actor, (trx) =>
      trx
        .selectFrom('people')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('email', '=', 'dupe@example.test')
        .execute(),
    );
    expect(still).toHaveLength(1);
  });
});
