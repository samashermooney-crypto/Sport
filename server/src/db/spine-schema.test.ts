import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

describe('schema spine contract', () => {
  it('uses composite tenant foreign keys across the critical parent graph', async () => {
    const result = await admin.query<{
      child_table: string;
      parent_table: string;
      child_columns: string[];
      parent_columns: string[];
    }>(`
      SELECT c.conrelid::regclass::text AS child_table,
             c.confrelid::regclass::text AS parent_table,
             array_agg(child.attname::text ORDER BY pair.ord) AS child_columns,
             array_agg(parent.attname::text ORDER BY pair.ord) AS parent_columns
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey)
        WITH ORDINALITY AS pair(child_attnum, parent_attnum, ord)
      JOIN pg_attribute child ON child.attrelid = c.conrelid AND child.attnum = pair.child_attnum
      JOIN pg_attribute parent ON parent.attrelid = c.confrelid AND parent.attnum = pair.parent_attnum
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      GROUP BY c.oid
    `);
    const relations = result.rows.map(
      (row) =>
        `${row.child_table}:${row.child_columns.join(',')}→${row.parent_table}:${row.parent_columns.join(',')}`,
    );
    for (const [child, column, parent] of [
      ['household_members', 'household_id', 'households'],
      ['household_members', 'person_id', 'people'],
      ['divisions', 'program_id', 'programs'],
      ['registration_offerings', 'division_id', 'divisions'],
      ['registrations', 'offering_id', 'registration_offerings'],
      ['team_seasons', 'team_id', 'teams'],
      ['roster_entries', 'team_season_id', 'team_seasons'],
      ['team_staff', 'team_season_id', 'team_seasons'],
      ['invoice_lines', 'invoice_id', 'invoices'],
      ['installments', 'invoice_id', 'invoices'],
      ['payment_allocations', 'invoice_id', 'invoices'],
      ['payment_allocations', 'payment_id', 'payments'],
      ['contests', 'event_id', 'events'],
      ['contest_participants', 'contest_id', 'contests'],
      ['contest_results', 'contest_participant_id', 'contest_participants'],
    ] as Array<[string, string, string]>) {
      expect(relations, `${child}.${column} → ${parent}`).toContain(
        `${child}:org_id,${column}→${parent}:org_id,id`,
      );
    }
  });

  it('never references a tenant parent through an unscoped foreign key', async () => {
    const result = await admin.query<{
      constraint_name: string;
      child_table: string;
      parent_table: string;
      child_columns: string[];
      parent_columns: string[];
    }>(`
      SELECT c.conname AS constraint_name,
             c.conrelid::regclass::text AS child_table,
             c.confrelid::regclass::text AS parent_table,
             array_agg(child.attname::text ORDER BY pair.ord) AS child_columns,
             array_agg(parent.attname::text ORDER BY pair.ord) AS parent_columns
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey)
        WITH ORDINALITY AS pair(child_attnum, parent_attnum, ord)
      JOIN pg_attribute child ON child.attrelid = c.conrelid AND child.attnum = pair.child_attnum
      JOIN pg_attribute parent ON parent.attrelid = c.confrelid AND parent.attnum = pair.parent_attnum
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'org_id')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'org_id')
      GROUP BY c.oid
    `);
    const unscoped = result.rows.filter(
      (row) =>
        !row.child_columns.includes('org_id') ||
        !row.parent_columns.includes('org_id'),
    );
    expect(unscoped).toEqual([]);
  });

  it('enforces capacity and split-space hard constraints in the database', async () => {
    const result = await admin.query<{
      table_name: string;
      definition: string;
    }>(`
      SELECT c.conrelid::regclass::text AS table_name,
             pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      WHERE c.conrelid IN ('capacity_counters'::regclass, 'space_bookings'::regclass)
    `);
    const capacity = result.rows
      .filter((row) => row.table_name === 'capacity_counters')
      .map((row) => row.definition)
      .join(' ');
    const bookings = result.rows
      .filter((row) => row.table_name === 'space_bookings')
      .map((row) => row.definition)
      .join(' ');
    expect(capacity).toContain('confirmed >= 0');
    expect(capacity).toContain('held >= 0');
    expect(bookings).toContain('EXCLUDE USING gist');
    expect(bookings).toContain('leaf_space_id WITH =');
  });

  it('indexes every foreign-key lookup', async () => {
    const foreignKeys = await admin.query<{
      table_oid: number;
      constraint_name: string;
      column_numbers: string;
    }>(`
      SELECT conrelid::integer AS table_oid, conname AS constraint_name,
             array_to_string(conkey, ' ') AS column_numbers
      FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `);
    const indexes = await admin.query<{
      table_oid: number;
      column_numbers: string;
    }>(`
      SELECT indrelid::integer AS table_oid, indkey::text AS column_numbers
      FROM pg_index WHERE indisvalid AND indisready
    `);
    const missing = foreignKeys.rows
      .filter((key) => {
        const columns = key.column_numbers.split(' ').sort().join(' ');
        const count = key.column_numbers.split(' ').length;
        return !indexes.rows.some(
          (index) =>
            index.table_oid === key.table_oid &&
            index.column_numbers.split(' ').slice(0, count).sort().join(' ') ===
              columns,
        );
      })
      .map((key) => key.constraint_name);
    expect(missing).toEqual([]);
  });
});
