import { sql } from 'kysely';

import type { OrgTransaction } from '../../db/withOrg';

import type { ImportDuplicate } from './phase15-schema';

export async function findDuplicateCandidates(
  trx: OrgTransaction,
  orgId: string,
  person: {
    first: string;
    last: string;
    dob: string | null;
    email: string | null;
    phone: string | null;
  },
): Promise<ImportDuplicate[]> {
  const fullName = `${person.first} ${person.last}`.trim();
  const candidates = new Map<string, { name: string; reasons: Set<string> }>();
  const add = (id: string, name: string, reason: string) => {
    const entry = candidates.get(id) ?? { name, reasons: new Set<string>() };
    entry.reasons.add(reason);
    candidates.set(id, entry);
  };
  if (person.email) {
    const rows = await trx
      .selectFrom('people')
      .select(['id', 'first_name', 'last_name'])
      .where('org_id', '=', orgId)
      .where('email', '=', person.email)
      .where('status', '=', 'active')
      .execute();
    for (const row of rows)
      add(row.id, `${row.first_name} ${row.last_name}`, 'same email');
  }
  if (person.phone) {
    const rows = await trx
      .selectFrom('people')
      .select(['id', 'first_name', 'last_name'])
      .where('org_id', '=', orgId)
      .where('phone_e164', '=', person.phone)
      .where('status', '=', 'active')
      .execute();
    for (const row of rows)
      add(row.id, `${row.first_name} ${row.last_name}`, 'same phone');
  }
  if (person.dob && fullName.length >= 3) {
    const rows = await sql<{ id: string; name: string; score: number }>`
      SELECT id, first_name || ' ' || last_name AS name,
        similarity(lower(first_name || ' ' || last_name), lower(${fullName})) AS score
      FROM people
      WHERE org_id = ${orgId}
        AND status = 'active'
        AND date_of_birth = ${person.dob}
        AND similarity(lower(first_name || ' ' || last_name), lower(${fullName})) >= 0.55
      LIMIT 10
    `.execute(trx);
    for (const row of rows.rows)
      add(row.id, row.name, 'same birth date and similar name');
  }
  return [...candidates.entries()].map(([personId, entry]) => ({
    personId,
    name: entry.name,
    reasons: [...entry.reasons],
  }));
}
