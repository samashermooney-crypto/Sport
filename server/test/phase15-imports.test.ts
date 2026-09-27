import { randomBytes } from 'node:crypto';

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DB } from '../src/db/types';
import { MemoryStorage } from '../src/integrations/storage/storage';
import { parseEncryptionKeys } from '../src/lib/crypto';
import {
  ImportParseError,
  parseCsv,
  parseImportFile,
} from '../src/modules/imports/phase15-parse';
import { createImportsService } from '../src/modules/imports/phase15-service';
import { readZip } from '../src/modules/imports/phase15-zip';

import { createTestFactories } from './factories';
import type { ActorFixture } from './factories';

const { Pool } = pg;
let database: Kysely<DB>;
let factories: ReturnType<typeof createTestFactories>;
let staff: ActorFixture;

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
  staff = await factories.actor();
  await factories.scoped(staff, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', staff.orgId)
      .where('account_id', '=', staff.accountId)
      .execute()
      .then(() => undefined),
  );
});

afterAll(async () => {
  await database.destroy();
});

function makeZip(entries: { name: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

async function createPerson(
  email: string,
  name = 'Roster Athlete',
): Promise<string> {
  const nameParts = name.split(' ');
  const firstName = nameParts[0] ?? 'Roster';
  const lastName = nameParts.at(-1) ?? firstName;
  const personId = await factories.person(staff, {
    firstName,
    lastName,
  });
  await factories.scoped(staff, (trx) =>
    trx
      .updateTable('people')
      .set({ email })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', personId)
      .execute()
      .then(() => undefined),
  );
  return personId;
}

function csv(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

describe('Phase 15 import parsing', () => {
  it('accepts UTF-8 BOM and Windows-1252, and rejects duplicate headers', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...csv('First,Last\nA,B')]);
    expect(parseCsv(bom).rows).toEqual([{ First: 'A', Last: 'B' }]);
    expect(
      parseCsv(Uint8Array.from([...csv('Name\nNa'), 0xef, ...csv('ve')]))
        .rows[0]?.['Name'],
    ).toBe('Naïve');
    expect(() => parseCsv(csv('Name,name\nA,B'))).toThrow(ImportParseError);
  });

  it('parses one CSV plus named documents from a small credential zip', async () => {
    const archive = makeZip([
      {
        name: 'credentials.csv',
        bytes: csv(
          'Person email,Credential type,Document file\na@example.test,Background check,check.pdf',
        ),
      },
      { name: 'documents/check.pdf', bytes: csv('%PDF-1.4 fake fixture') },
    ]);
    const entries = readZip(archive);
    expect(entries.map((entry) => entry.name)).toEqual([
      'credentials.csv',
      'documents/check.pdf',
    ]);
    const csvEntry = required(entries.at(0), 'CSV archive entry');
    expect(
      (await parseImportFile('credentials.csv', csvEntry.bytes)).rows,
    ).toHaveLength(1);
  });
});

describe('Phase 15 import transactions', () => {
  it('previews, commits, and rolls back teams and roster rows without deleting reused fixtures', async () => {
    await factories.program(staff);
    const participantEmail = `roster-${crypto.randomUUID()}@example.test`;
    const personId = await createPerson(participantEmail);
    const imports = createImportsService(database, null);
    const team = await imports.createBatch(staff.orgId, staff.accountId, {
      kind: 'teams',
      fileName: 'teams.csv',
      bytes: csv(
        'Team name,Program,Division\nImported Falcons,Fixture League,Open',
      ),
    });
    expect(team.mapping).not.toBeNull();
    expect(
      await imports.validateBatch(staff.orgId, team.id, staff.accountId),
    ).toMatchObject({ rowCount: 1, errorCount: 0 });
    const committedTeam = await imports.commitBatch(
      staff.orgId,
      team.id,
      staff.accountId,
    );
    expect(committedTeam).toMatchObject({
      teams_created: 1,
      team_seasons_created: 1,
    });
    const savedTeam = await factories.scoped(staff, (trx) =>
      trx
        .selectFrom('teams')
        .select('id')
        .where('org_id', '=', staff.orgId)
        .where('name', '=', 'Imported Falcons')
        .executeTakeFirstOrThrow(),
    );

    const roster = await imports.createBatch(staff.orgId, staff.accountId, {
      kind: 'rosters',
      fileName: 'roster.csv',
      bytes: csv(
        `Team name,Program,Person email,Role,Number\nImported Falcons,Fixture League,${participantEmail},player,18`,
      ),
    });
    expect(
      await imports.validateBatch(staff.orgId, roster.id, staff.accountId),
    ).toMatchObject({ rowCount: 1, errorCount: 0 });
    expect(
      await imports.commitBatch(staff.orgId, roster.id, staff.accountId),
    ).toMatchObject({ rostered: 1 });
    await imports.rollbackBatch(staff.orgId, roster.id, staff.accountId);
    await imports.rollbackBatch(staff.orgId, team.id, staff.accountId);

    const teamAfter = await factories.scoped(staff, (trx) =>
      trx
        .selectFrom('teams')
        .select('status')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', savedTeam.id)
        .executeTakeFirstOrThrow(),
    );
    const seasonAfter = await factories.scoped(staff, (trx) =>
      trx
        .selectFrom('team_seasons')
        .select('status')
        .where('org_id', '=', staff.orgId)
        .where('team_id', '=', savedTeam.id)
        .executeTakeFirstOrThrow(),
    );
    const rosterAfter = await factories.scoped(staff, (trx) =>
      trx
        .selectFrom('roster_entries')
        .select('status')
        .where('org_id', '=', staff.orgId)
        .where('person_id', '=', personId)
        .executeTakeFirstOrThrow(),
    );
    const personAfter = await factories.scoped(staff, (trx) =>
      trx
        .selectFrom('people')
        .select('id')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', personId)
        .executeTakeFirst(),
    );
    expect(teamAfter.status).toBe('retired');
    expect(seasonAfter.status).toBe('withdrawn');
    expect(rosterAfter.status).toBe('released');
    expect(personAfter?.id).toBe(personId);
  });

  it('previews and rolls back a zipped credential without trusting an imported verified status', async () => {
    const email = `credential-${crypto.randomUUID()}@example.test`;
    const personId = await createPerson(email, 'Taylor Coach');
    const storage = new MemoryStorage();
    const encryption = parseEncryptionKeys(
      JSON.stringify({ test: randomBytes(32).toString('base64') }),
      'test',
    );
    const imports = createImportsService(database, encryption, storage);
    const archive = makeZip([
      {
        name: 'credentials.csv',
        bytes: csv(
          `Person email,Credential type,Status,Expires on,Identifier,Document file\n${email},Background check,verified,2027-01-01,ABC-123,check.pdf`,
        ),
      },
      { name: 'docs/check.pdf', bytes: csv('%PDF-1.4 fake fixture') },
    ]);
    const batch = await imports.createBatch(staff.orgId, staff.accountId, {
      kind: 'credentials',
      fileName: 'credentials.zip',
      bytes: archive,
    });
    const validation = await imports.validateBatch(
      staff.orgId,
      batch.id,
      staff.accountId,
    );
    const rows = await imports.listRows(
      staff.orgId,
      staff.accountId,
      batch.id,
      { limit: 10, filter: 'all' },
    );
    expect(rows.items[0]?.issues).toEqual([]);
    expect(validation).toMatchObject({ rowCount: 1, errorCount: 0 });
    expect(rows.items[0]?.normalized).toMatchObject({
      status: 'pending_review',
      document_file: 'check.pdf',
    });
    expect(
      await imports.commitBatch(staff.orgId, batch.id, staff.accountId),
    ).toMatchObject({ credentials_created: 1 });
    const credential = await factories.scoped(staff, (trx) =>
      trx
        .selectFrom('person_credentials')
        .selectAll()
        .where('org_id', '=', staff.orgId)
        .where('person_id', '=', personId)
        .executeTakeFirstOrThrow(),
    );
    expect(credential.status).toBe('pending_review');
    expect(credential.identifier_enc).not.toBeNull();
    expect(credential.file_id).not.toBeNull();
    await imports.rollbackBatch(staff.orgId, batch.id, staff.accountId);
    const after = await factories.scoped(staff, (trx) =>
      trx
        .selectFrom('person_credentials')
        .select('status')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', credential.id)
        .executeTakeFirstOrThrow(),
    );
    expect(after.status).toBe('revoked');
  });

  it('records historical payments as external and preserves the ledger on rollback', async () => {
    const email = `history-${crypto.randomUUID()}@example.test`;
    await createPerson(email, 'Historical Payer');
    const imports = createImportsService(database, null);
    const batch = await imports.createBatch(staff.orgId, staff.accountId, {
      kind: 'historical_payments',
      fileName: 'historical-payments.csv',
      bytes: csv(
        `Payer email,Amount,Paid on,Method,Reference,Description\n${email},149.00,2025-08-15,card,old-system-1042,2025 registration`,
      ),
    });
    expect(
      await imports.validateBatch(staff.orgId, batch.id, staff.accountId),
    ).toMatchObject({ rowCount: 1, errorCount: 0 });
    expect(
      await imports.commitBatch(staff.orgId, batch.id, staff.accountId),
    ).toMatchObject({ created: 1, total_cents: 14_900 });

    const saved = await factories.scoped(staff, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select(['id', 'method', 'status', 'amount_cents', 'reference'])
        .where('org_id', '=', staff.orgId)
        .where('reference', '=', 'old-system-1042')
        .executeTakeFirstOrThrow();
      const allocation = await trx
        .selectFrom('payment_allocations')
        .select(['id', 'invoice_id'])
        .where('org_id', '=', staff.orgId)
        .where('payment_id', '=', payment.id)
        .executeTakeFirstOrThrow();
      const invoice = await trx
        .selectFrom('invoices')
        .select(['id', 'status', 'paid_cents'])
        .where('org_id', '=', staff.orgId)
        .where('id', '=', allocation.invoice_id)
        .executeTakeFirstOrThrow();
      const line = await trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('org_id', '=', staff.orgId)
        .where('invoice_id', '=', invoice.id)
        .executeTakeFirstOrThrow();
      return { payment, invoice, allocation, line };
    });
    expect(saved.payment).toMatchObject({
      method: 'external',
      status: 'succeeded',
      amount_cents: 14_900,
    });
    expect(saved.invoice).toMatchObject({ status: 'paid', paid_cents: 14_900 });

    expect(
      await imports.rollbackBatch(staff.orgId, batch.id, staff.accountId),
    ).toMatchObject({
      reversed: { payments: 1, invoices: 1 },
      retained_records: { payment_allocations: 1, invoice_lines: 1 },
    });
    const after = await factories.scoped(staff, async (trx) => ({
      payment: await trx
        .selectFrom('payments')
        .select('status')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', saved.payment.id)
        .executeTakeFirstOrThrow(),
      invoice: await trx
        .selectFrom('invoices')
        .select(['status', 'paid_cents'])
        .where('org_id', '=', staff.orgId)
        .where('id', '=', saved.invoice.id)
        .executeTakeFirstOrThrow(),
      allocation: await trx
        .selectFrom('payment_allocations')
        .select('id')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', saved.allocation.id)
        .executeTakeFirst(),
      line: await trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', saved.line.id)
        .executeTakeFirst(),
    }));
    expect(after.payment.status).toBe('canceled');
    expect(after.invoice).toMatchObject({ status: 'void', paid_cents: 0 });
    expect(after.allocation).not.toBeNull();
    expect(after.line).not.toBeNull();
  });

  it('imports volunteer hours against the Phase 11 contract and reverses the credit', async () => {
    const email = `volunteer-${crypto.randomUUID()}@example.test`;
    const personId = await createPerson(email, 'Morgan Volunteer');
    const householdId = await factories.household(staff);
    const facilityId = crypto.randomUUID();
    await factories.scoped(staff, async (trx) => {
      await trx
        .insertInto('household_members')
        .values({
          id: crypto.randomUUID(),
          org_id: staff.orgId,
          household_id: householdId,
          person_id: personId,
          role: 'other_adult',
          financially_responsible: true,
          is_primary_contact: true,
        })
        .execute();
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: staff.orgId,
          name: 'Volunteer Import Field',
          ownership: 'owned',
        })
        .execute();
    });
    const imports = createImportsService(database, null);
    const missingFacilityBatch = await imports.createBatch(
      staff.orgId,
      staff.accountId,
      {
        kind: 'volunteer_hours',
        fileName: 'volunteer-hours-without-facility.csv',
        bytes: csv(
          `Person email,Volunteer role,Hours,Date\n${email},Field marshal,3.5,2026-03-14`,
        ),
      },
    );
    const missingFacilityValidation = await imports.validateBatch(
      staff.orgId,
      missingFacilityBatch.id,
      staff.accountId,
    );
    expect(missingFacilityValidation.rowCount).toBe(1);
    expect(missingFacilityValidation.errorCount).toBeGreaterThan(0);

    const batch = await imports.createBatch(staff.orgId, staff.accountId, {
      kind: 'volunteer_hours',
      fileName: 'volunteer-hours.csv',
      bytes: csv(
        `Person email,Volunteer role,Shift name,Facility,Hours,Date,Notes\n${email},Field marshal,Opening day,Volunteer Import Field,3.5,2026-03-14,Field setup`,
      ),
    });
    expect(
      await imports.validateBatch(staff.orgId, batch.id, staff.accountId),
    ).toMatchObject({ rowCount: 1, errorCount: 0 });
    expect(
      await imports.commitBatch(staff.orgId, batch.id, staff.accountId),
    ).toMatchObject({ credited: 1, hours_total: 3.5 });

    const imported = await factories.scoped(staff, async (trx) => {
      const signup = await trx
        .selectFrom('volunteer_signups')
        .selectAll()
        .where('org_id', '=', staff.orgId)
        .where('person_id', '=', personId)
        .executeTakeFirstOrThrow();
      const shift = await trx
        .selectFrom('volunteer_shifts')
        .selectAll()
        .where('org_id', '=', staff.orgId)
        .where('id', '=', signup.volunteer_shift_id)
        .executeTakeFirstOrThrow();
      const role = await trx
        .selectFrom('volunteer_roles')
        .selectAll()
        .where('org_id', '=', staff.orgId)
        .where('id', '=', shift.volunteer_role_id)
        .executeTakeFirstOrThrow();
      return { signup, shift, role };
    });
    expect(imported.signup).toMatchObject({
      household_id: householdId,
      status: 'completed',
      hours_credited: '3.50',
      credited_by: staff.accountId,
      created_by: staff.accountId,
    });
    expect(imported.shift).toMatchObject({
      facility_id: facilityId,
      slots: 1,
      credit_hours: '3.50',
      status: 'completed',
      created_by: staff.accountId,
    });
    expect(imported.shift.notes).toContain('Opening day');
    expect(imported.role.name).toBe('Field marshal');
    expect(imported.role.created_by).toBe(staff.accountId);

    expect(
      await imports.rollbackBatch(staff.orgId, batch.id, staff.accountId),
    ).toMatchObject({
      reversed: {
        volunteer_signups: 1,
        volunteer_shifts: 1,
        volunteer_roles: 1,
      },
    });
    const after = await factories.scoped(staff, async (trx) => ({
      signup: await trx
        .selectFrom('volunteer_signups')
        .select('status')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', imported.signup.id)
        .executeTakeFirstOrThrow(),
      shift: await trx
        .selectFrom('volunteer_shifts')
        .select('status')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', imported.shift.id)
        .executeTakeFirstOrThrow(),
      role: await trx
        .selectFrom('volunteer_roles')
        .select('archived_at')
        .where('org_id', '=', staff.orgId)
        .where('id', '=', imported.role.id)
        .executeTakeFirstOrThrow(),
    }));
    expect(after.signup.status).toBe('canceled');
    expect(after.shift.status).toBe('canceled');
    expect(after.role.archived_at).not.toBeNull();
  });

  it('requires an explicit create or skip decision for duplicate people rows', async () => {
    const email = `duplicate-${crypto.randomUUID()}@example.test`;
    await createPerson(email, 'Returning Player');
    const imports = createImportsService(database, null);
    const batch = await imports.createBatch(staff.orgId, staff.accountId, {
      kind: 'people',
      fileName: 'returning.csv',
      bytes: csv(`First name,Last name,Email\nReturning,Player,${email}`),
    });
    await imports.validateBatch(staff.orgId, batch.id, staff.accountId);
    const rows = await imports.listRows(
      staff.orgId,
      staff.accountId,
      batch.id,
      { limit: 10, filter: 'all' },
    );
    expect(rows.items[0]?.duplicates).toHaveLength(1);
    const duplicateRow = required(rows.items.at(0), 'duplicate import row');
    await imports.decideRows(staff.orgId, staff.accountId, batch.id, [
      { rowId: duplicateRow.id, action: 'skip' },
    ]);
    const committed = await imports.commitBatch(
      staff.orgId,
      batch.id,
      staff.accountId,
    );
    expect(committed).toMatchObject({ created: 0 });
  });
});
