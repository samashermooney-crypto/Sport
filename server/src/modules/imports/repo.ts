import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type {
  ImportBatch,
  ImportBatchCreate,
  ImportDuplicateStrategy,
  ImportKind,
  ImportRowIssue,
} from '@shared/schemas/imports';
import type { Insertable, Kysely } from 'kysely';
import { sql } from 'kysely';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import Papa from 'papaparse';

import type { DB, JsonValue } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';
import { ensureGuardianProfileAndHousehold } from '../people/guardianProfile';
import { PeopleError, requireStaff } from '../people/repo';

interface RawRow {
  [column: string]: string;
}

interface NormalizedPerson {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  email: string | null;
  phoneE164: string | null;
  gender: 'female' | 'male' | 'nonbinary' | 'unspecified';
  graduationYear: number | null;
  schoolName: string | null;
  householdName: string | null;
  emergencyContactName: string | null;
  emergencyContactPhoneE164: string | null;
}

interface NormalizedHousehold {
  name: string | null;
}

interface NormalizedGuardian {
  guardianEmail: string | null;
  personFirstName: string;
  personLastName: string;
  personDateOfBirth: string | null;
  personEmail: string | null;
}

interface NormalizedEmergencyContact {
  personEmail: string | null;
  personFirstName: string;
  personLastName: string;
  personDateOfBirth: string | null;
  name: string;
  relationship: string;
  phoneE164: string | null;
  priority: number;
}

type Normalized =
  | NormalizedPerson
  | NormalizedHousehold
  | NormalizedGuardian
  | NormalizedEmergencyContact;

interface StagedRow {
  rowNumber: number;
  raw: RawRow;
  normalized: Normalized | null;
  action: 'create' | 'update' | 'merge' | 'skip' | 'invalid';
  issues: ImportRowIssue[];
  duplicateOf?: { personId: string } | { rowNumber: number };
}

interface PersonImportSnapshot {
  expectedVersion: number;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  email: string | null;
  phone_e164: string | null;
  gender: 'female' | 'male' | 'nonbinary' | 'unspecified';
  graduation_year: number | null;
  school_name: string | null;
}

const issue = (
  field: string,
  code: string,
  message: string,
): ImportRowIssue => ({ field, code, message });

function mapped(raw: RawRow, mapping: Record<string, string>, field: string) {
  const column = mapping[field];
  if (column === undefined) return '';
  return (raw[column] ?? '').trim();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const dobKey = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value;

function personNameDobKey(
  firstName: string,
  lastName: string,
  dateOfBirth: string | null,
): string {
  return JSON.stringify([
    firstName.trim().toLocaleLowerCase(),
    lastName.trim().toLocaleLowerCase(),
    dateOfBirth,
  ]);
}

function normalizeEmail(raw: string): string | null {
  if (raw === '') return null;
  const email = raw.toLowerCase();
  return EMAIL_PATTERN.test(email) ? email : null;
}

const ISO_DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const US_DATE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/;

function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const iso = ISO_DATE.exec(trimmed);
  const us = iso === null ? US_DATE.exec(trimmed) : null;
  if (iso === null && us === null) return null;
  const [year, month, day] =
    iso !== null
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : [
          Number((us as RegExpExecArray)[3]),
          Number((us as RegExpExecArray)[1]),
          Number((us as RegExpExecArray)[2]),
        ];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  )
    return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const GENDERS: Record<string, NormalizedPerson['gender']> = {
  f: 'female',
  female: 'female',
  girl: 'female',
  woman: 'female',
  m: 'male',
  male: 'male',
  boy: 'male',
  man: 'male',
  nb: 'nonbinary',
  'non-binary': 'nonbinary',
  nonbinary: 'nonbinary',
  u: 'unspecified',
  unknown: 'unspecified',
  unspecified: 'unspecified',
};

function normalizePhone(raw: string): string | null {
  if (raw === '') return null;
  const parsed = parsePhoneNumberFromString(raw, 'US');
  return parsed?.isValid() ? parsed.number : null;
}

function normalizePersonRow(
  raw: RawRow,
  mapping: Record<string, string>,
): { normalized: NormalizedPerson | null; issues: ImportRowIssue[] } {
  const issues: ImportRowIssue[] = [];
  const firstName = mapped(raw, mapping, 'firstName');
  const lastName = mapped(raw, mapping, 'lastName');
  if (firstName === '')
    issues.push(issue('firstName', 'required', 'First name is required'));
  if (lastName === '')
    issues.push(issue('lastName', 'required', 'Last name is required'));

  const dobRaw = mapped(raw, mapping, 'dateOfBirth');
  const dateOfBirth = normalizeDate(dobRaw);
  if (dobRaw === '')
    issues.push(issue('dateOfBirth', 'required', 'Date of birth is required'));
  else if (dateOfBirth === null)
    issues.push(
      issue('dateOfBirth', 'invalid_date', `Unrecognized date "${dobRaw}"`),
    );

  const emailRaw = mapped(raw, mapping, 'email');
  const email = normalizeEmail(emailRaw);
  if (emailRaw !== '' && email === null)
    issues.push(issue('email', 'invalid_email', `Invalid email "${emailRaw}"`));

  const phoneRaw = mapped(raw, mapping, 'phone');
  const phoneE164 = normalizePhone(phoneRaw);
  if (phoneRaw !== '' && phoneE164 === null)
    issues.push(issue('phone', 'invalid_phone', `Invalid phone "${phoneRaw}"`));

  const genderRaw = mapped(raw, mapping, 'gender').toLowerCase();
  const gender =
    GENDERS[genderRaw] ?? (genderRaw === '' ? 'unspecified' : null);
  if (gender === null)
    issues.push(
      issue('gender', 'invalid_gender', `Invalid gender "${genderRaw}"`),
    );

  const yearRaw = mapped(raw, mapping, 'graduationYear');
  const graduationYear =
    yearRaw === '' ? null : /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
  if (yearRaw !== '' && graduationYear === null)
    issues.push(
      issue(
        'graduationYear',
        'invalid_year',
        `Invalid graduation year "${yearRaw}"`,
      ),
    );

  const emergencyPhoneRaw = mapped(raw, mapping, 'emergencyContactPhone');
  const emergencyContactPhoneE164 = normalizePhone(emergencyPhoneRaw);
  if (emergencyPhoneRaw !== '' && emergencyContactPhoneE164 === null)
    issues.push(
      issue(
        'emergencyContactPhone',
        'invalid_phone',
        `Invalid emergency phone "${emergencyPhoneRaw}"`,
      ),
    );

  if (issues.length > 0) return { normalized: null, issues };
  return {
    normalized: {
      firstName,
      lastName,
      dateOfBirth,
      email,
      phoneE164,
      gender: gender ?? 'unspecified',
      graduationYear,
      schoolName: mapped(raw, mapping, 'schoolName') || null,
      householdName: mapped(raw, mapping, 'householdName') || null,
      emergencyContactName:
        mapped(raw, mapping, 'emergencyContactName') || null,
      emergencyContactPhoneE164,
    },
    issues,
  };
}

function normalizeHouseholdRow(
  raw: RawRow,
  mapping: Record<string, string>,
): { normalized: NormalizedHousehold | null; issues: ImportRowIssue[] } {
  const name = mapped(raw, mapping, 'householdName');
  const issues =
    name === ''
      ? [issue('householdName', 'required', 'Household name is required')]
      : [];
  return { normalized: issues.length ? null : { name }, issues };
}

function normalizeGuardianRow(
  raw: RawRow,
  mapping: Record<string, string>,
): { normalized: NormalizedGuardian | null; issues: ImportRowIssue[] } {
  const issues: ImportRowIssue[] = [];
  const guardianEmail = normalizeEmail(mapped(raw, mapping, 'guardianEmail'));
  if (guardianEmail === null)
    issues.push(
      issue('guardianEmail', 'required', 'Guardian email is required'),
    );
  const personEmail = normalizeEmail(mapped(raw, mapping, 'personEmail'));
  const personFirstName = mapped(raw, mapping, 'personFirstName');
  const personLastName = mapped(raw, mapping, 'personLastName');
  const personDateOfBirth = normalizeDate(
    mapped(raw, mapping, 'personDateOfBirth'),
  );
  if (personEmail === null && personDateOfBirth === null)
    issues.push(
      issue(
        'personEmail',
        'required',
        'Person email or birth date is required',
      ),
    );
  if (personEmail === null && (personFirstName === '' || personLastName === ''))
    issues.push(
      issue(
        'personFirstName',
        'required',
        'Person name is required without an email',
      ),
    );
  if (issues.length > 0) return { normalized: null, issues };
  return {
    normalized: {
      guardianEmail,
      personFirstName,
      personLastName,
      personDateOfBirth,
      personEmail,
    },
    issues,
  };
}

function normalizeContactRow(
  raw: RawRow,
  mapping: Record<string, string>,
): { normalized: NormalizedEmergencyContact | null; issues: ImportRowIssue[] } {
  const issues: ImportRowIssue[] = [];
  const personEmail = normalizeEmail(mapped(raw, mapping, 'personEmail'));
  const personFirstName = mapped(raw, mapping, 'personFirstName');
  const personLastName = mapped(raw, mapping, 'personLastName');
  const personDateOfBirth = normalizeDate(
    mapped(raw, mapping, 'personDateOfBirth'),
  );
  if (personEmail === null && personDateOfBirth === null)
    issues.push(
      issue(
        'personEmail',
        'required',
        'Person email or birth date is required',
      ),
    );
  if (personEmail === null && (personFirstName === '' || personLastName === ''))
    issues.push(
      issue(
        'personFirstName',
        'required',
        'Person name is required without an email',
      ),
    );
  const name = mapped(raw, mapping, 'contactName');
  if (name === '')
    issues.push(issue('contactName', 'required', 'Contact name is required'));
  const phoneE164 = normalizePhone(mapped(raw, mapping, 'contactPhone'));
  if (phoneE164 === null)
    issues.push(
      issue('contactPhone', 'invalid_phone', 'Contact phone is required'),
    );
  const priorityRaw = mapped(raw, mapping, 'priority');
  const priority = priorityRaw === '' ? 1 : Number(priorityRaw);
  if (!Number.isInteger(priority) || priority < 1)
    issues.push(
      issue(
        'priority',
        'invalid_priority',
        'Priority must be a positive integer',
      ),
    );
  if (issues.length > 0) return { normalized: null, issues };
  return {
    normalized: {
      personEmail,
      personFirstName,
      personLastName,
      personDateOfBirth,
      name,
      relationship: mapped(raw, mapping, 'relationship') || 'emergency contact',
      phoneE164,
      priority,
    },
    issues,
  };
}

const NORMALIZERS = {
  people: normalizePersonRow,
  households: normalizeHouseholdRow,
  guardians: normalizeGuardianRow,
  emergency_contacts: normalizeContactRow,
} as const;

function toBatch(row: {
  id: string;
  kind: string;
  filename: string;
  status: string;
  stats: unknown;
  created_by: string;
  created_at: Date;
  committed_at: Date | null;
  rolled_back_at: Date | null;
}): ImportBatch {
  const stats = (row.stats ?? {}) as Partial<ImportBatch['stats']>;
  return {
    id: row.id,
    kind: row.kind as ImportBatch['kind'],
    filename: row.filename,
    status: row.status as ImportBatch['status'],
    stats: {
      total: stats.total ?? 0,
      create: stats.create ?? 0,
      update: stats.update ?? 0,
      merge: stats.merge ?? 0,
      skip: stats.skip ?? 0,
      invalid: stats.invalid ?? 0,
    },
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    committedAt: row.committed_at?.toISOString() ?? null,
    rolledBackAt: row.rolled_back_at?.toISOString() ?? null,
  };
}

interface CreatedRef {
  type:
    | 'person'
    | 'household'
    | 'household_member'
    | 'emergency_contact'
    | 'person_account_link';
  id: string;
}

export function createImportsRepository(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);

  async function stageRows(
    trx: OrgTransaction,
    orgId: string,
    kind: ImportKind,
    raws: RawRow[],
    mapping: Record<string, string>,
    duplicateStrategy: ImportDuplicateStrategy,
  ): Promise<StagedRow[]> {
    const normalize = NORMALIZERS[kind];
    const staged: StagedRow[] = raws.map((raw, index) => {
      const { normalized, issues } = normalize(raw, mapping);
      return {
        rowNumber: index + 1,
        raw,
        normalized,
        action: normalized === null ? 'invalid' : 'create',
        issues,
      };
    });

    if (kind === 'people') {
      const existing = await trx
        .selectFrom('people')
        .select([
          'id',
          'first_name',
          'last_name',
          'date_of_birth',
          'email',
          'phone_e164',
        ])
        .where('org_id', '=', orgId)
        .where('status', '=', 'active')
        .execute();
      const byEmail = new Map<string, string>();
      const byPhone = new Map<string, string>();
      const byNameDob = new Map<string, string>();
      for (const person of existing) {
        if (person.email) byEmail.set(person.email.toLowerCase(), person.id);
        if (person.phone_e164) byPhone.set(person.phone_e164, person.id);
        byNameDob.set(
          personNameDobKey(
            person.first_name,
            person.last_name,
            dobKey(person.date_of_birth),
          ),
          person.id,
        );
      }
      const seenEmail = new Map<string, number>();
      const seenPhone = new Map<string, number>();
      const seenNameDob = new Map<string, number>();
      for (const row of staged) {
        if (row.normalized === null) continue;
        const person = row.normalized as NormalizedPerson;
        let duplicate: StagedRow['duplicateOf'];
        if (person.email && byEmail.has(person.email))
          duplicate = { personId: byEmail.get(person.email) as string };
        else if (person.phoneE164 && byPhone.has(person.phoneE164))
          duplicate = { personId: byPhone.get(person.phoneE164) as string };
        else {
          const key = personNameDobKey(
            person.firstName,
            person.lastName,
            person.dateOfBirth,
          );
          if (byNameDob.has(key))
            duplicate = { personId: byNameDob.get(key) as string };
        }
        if (duplicate === undefined) {
          if (person.email && seenEmail.has(person.email))
            duplicate = { rowNumber: seenEmail.get(person.email) as number };
          else if (person.phoneE164 && seenPhone.has(person.phoneE164))
            duplicate = {
              rowNumber: seenPhone.get(person.phoneE164) as number,
            };
          else {
            const key = personNameDobKey(
              person.firstName,
              person.lastName,
              person.dateOfBirth,
            );
            if (seenNameDob.has(key))
              duplicate = { rowNumber: seenNameDob.get(key) as number };
          }
        }
        if (duplicate !== undefined) {
          row.duplicateOf = duplicate;
          row.issues.push(
            issue(
              'row',
              'possible_duplicate',
              'personId' in duplicate
                ? `Matches existing person ${duplicate.personId}`
                : `Matches row ${String(duplicate.rowNumber)} in this file`,
            ),
          );
          row.action =
            duplicateStrategy === 'skip' ? 'skip' : duplicateStrategy;
          if (
            (row.action === 'update' || row.action === 'merge') &&
            'rowNumber' in duplicate
          )
            row.action = 'skip';
        } else {
          row.action = 'create';
        }
        if (person.email) seenEmail.set(person.email, row.rowNumber);
        if (person.phoneE164) seenPhone.set(person.phoneE164, row.rowNumber);
        seenNameDob.set(
          personNameDobKey(
            person.firstName,
            person.lastName,
            person.dateOfBirth,
          ),
          row.rowNumber,
        );
      }
    }
    return staged;
  }

  function statsFor(staged: StagedRow[]) {
    const stats = {
      total: staged.length,
      create: 0,
      update: 0,
      merge: 0,
      skip: 0,
      invalid: 0,
    };
    for (const row of staged) stats[row.action] += 1;
    return stats;
  }

  return {
    async create(orgId: string, actorId: string, input: ImportBatchCreate) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const parsed = Papa.parse<RawRow>(input.content.trim(), {
          header: true,
          skipEmptyLines: true,
        });
        if (parsed.errors.some((error) => error.type === 'Delimiter'))
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'File is not valid CSV',
          );
        if (parsed.data.length === 0)
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'File contains no rows',
          );
        if (parsed.data.length > 5000)
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'Files are limited to 5,000 rows',
          );
        const staged = await stageRows(
          trx,
          orgId,
          input.kind,
          parsed.data,
          input.mapping,
          input.duplicateStrategy,
        );
        const batchId = newId();
        const stats = statsFor(staged);
        await trx
          .insertInto('import_batches')
          .values({
            id: batchId,
            org_id: orgId,
            kind: input.kind,
            filename: input.filename,
            status: 'preview',
            mapping: input.mapping,
            stats,
            created_by: actorId,
          })
          .execute();
        const rowValues: Insertable<DB['import_rows']>[] = staged.map(
          (row) => ({
            id: newId(),
            org_id: orgId,
            batch_id: batchId,
            row_number: row.rowNumber,
            raw: row.raw,
            normalized: row.normalized as unknown as JsonValue,
            action: row.action,
            // node-postgres serializes top-level arrays as PostgreSQL arrays;
            // JSONB needs an explicit JSON string for issue lists.
            issues: JSON.stringify(row.issues),
            target_person_id:
              row.duplicateOf && 'personId' in row.duplicateOf
                ? row.duplicateOf.personId
                : null,
          }),
        );
        for (let index = 0; index < rowValues.length; index += 500)
          await trx
            .insertInto('import_rows')
            .values(rowValues.slice(index, index + 500))
            .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: actorId,
            action: 'import.preview_created',
            entity_type: 'import_batch',
            entity_id: batchId,
            changes: { kind: input.kind, rows: stats.total },
          })
          .execute();
        return {
          batch: toBatch({
            id: batchId,
            kind: input.kind,
            filename: input.filename,
            status: 'preview',
            stats,
            created_by: actorId,
            created_at: new Date(),
            committed_at: null,
            rolled_back_at: null,
          }),
          rows: staged.map((row) => ({
            rowNumber: row.rowNumber,
            action: row.action,
            issues: row.issues,
            normalized: row.normalized as Record<string, unknown> | null,
          })),
        };
      });
    },

    async commit(orgId: string, actorId: string, batchId: string) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const batch = await trx
          .selectFrom('import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .forUpdate()
          .executeTakeFirst();
        if (!batch)
          throw new PeopleError(404, 'NOT_FOUND', 'Import batch not found');
        if (batch.status !== 'preview')
          throw new PeopleError(
            409,
            'CONFLICT',
            `Batch is already ${batch.status}`,
          );
        const rows = await trx
          .selectFrom('import_rows')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('batch_id', '=', batchId)
          .orderBy('row_number')
          .execute();
        const refs = new Map<number, CreatedRef[]>();
        const beforeStates = new Map<number, PersonImportSnapshot>();
        if (batch.kind === 'people') {
          await commitPeople(
            trx,
            orgId,
            actorId,
            batchId,
            rows,
            refs,
            beforeStates,
          );
        } else if (batch.kind === 'households') {
          await commitHouseholds(trx, orgId, rows, refs);
        } else if (batch.kind === 'guardians') {
          await commitGuardians(trx, orgId, actorId, rows, refs);
        } else {
          await commitContacts(trx, orgId, rows, refs);
        }
        for (const row of rows) {
          const created = refs.get(row.row_number);
          const primary = created?.find(
            (ref) => ref.type === primaryType(batch.kind),
          );
          if (created === undefined) continue;
          await trx
            .updateTable('import_rows')
            .set({
              entity_type: primary?.type ?? created[0]?.type ?? null,
              entity_id: primary?.id ?? created[0]?.id ?? null,
              created_refs: JSON.stringify(
                row.action === 'create' ? created : [],
              ),
              before_state: beforeStates.has(row.row_number)
                ? (beforeStates.get(row.row_number) as unknown as JsonValue)
                : null,
            })
            .where('org_id', '=', orgId)
            .where('id', '=', row.id)
            .execute();
        }
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: actorId,
            action: 'import.batch_committed',
            entity_type: 'import_batch',
            entity_id: batchId,
            changes: { kind: batch.kind, rows: rows.length },
          })
          .execute();
        await trx
          .updateTable('import_batches')
          .set({
            status: 'committed',
            committed_at: new Date(),
            committed_by: actorId,
          })
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .execute();
        return toBatch({
          ...batch,
          status: 'committed',
          committed_at: new Date(),
          rolled_back_at: null,
        });
      });
    },

    async rollback(orgId: string, actorId: string, batchId: string) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const batch = await trx
          .selectFrom('import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .forUpdate()
          .executeTakeFirst();
        if (!batch)
          throw new PeopleError(404, 'NOT_FOUND', 'Import batch not found');
        if (batch.status !== 'committed')
          throw new PeopleError(
            409,
            'CONFLICT',
            'Only committed batches roll back',
          );
        const rows = await trx
          .selectFrom('import_rows')
          .select([
            'id',
            'row_number',
            'action',
            'entity_id',
            'created_refs',
            'before_state',
          ])
          .where('org_id', '=', orgId)
          .where('batch_id', '=', batchId)
          .execute();
        const refs = rows
          .filter((row) => row.action === 'create')
          .flatMap(
            (row) => (row.created_refs ?? []) as unknown as CreatedRef[],
          );
        const personIds = refs
          .filter((ref) => ref.type === 'person')
          .map((ref) => ref.id);
        const householdIds = refs
          .filter((ref) => ref.type === 'household')
          .map((ref) => ref.id);
        const memberIds = refs
          .filter((ref) => ref.type === 'household_member')
          .map((ref) => ref.id);
        const contactIds = refs
          .filter((ref) => ref.type === 'emergency_contact')
          .map((ref) => ref.id);
        const linkIds = refs
          .filter((ref) => ref.type === 'person_account_link')
          .map((ref) => ref.id);
        const reversibleUpdates = rows.filter(
          (row) => row.action === 'update' || row.action === 'merge',
        );
        const snapshots = reversibleUpdates.map((row) => {
          const snapshot =
            row.before_state as unknown as PersonImportSnapshot | null;
          if (!snapshot || !row.entity_id)
            throw new PeopleError(
              409,
              'CONFLICT',
              'An imported update has no rollback snapshot',
            );
          return { row, snapshot };
        });
        for (const { row, snapshot } of snapshots) {
          const current = await trx
            .selectFrom('people')
            .select(['id', 'version'])
            .where('org_id', '=', orgId)
            .where('id', '=', row.entity_id as string)
            .forUpdate()
            .executeTakeFirst();
          if (!current || current.version !== snapshot.expectedVersion)
            throw new PeopleError(
              409,
              'CONFLICT',
              'An imported profile changed after the batch and cannot be restored',
            );
        }
        if (personIds.length > 0) {
          const touched = await countTouchedPeople(trx, orgId, personIds, {
            memberIds,
            contactIds,
            linkIds,
          });
          if (touched > 0)
            throw new PeopleError(
              409,
              'CONFLICT',
              `${String(touched)} imported people have been touched since import and cannot roll back`,
              { touched },
            );
        }
        if (householdIds.length > 0) {
          const strayMembers = await trx
            .selectFrom('household_members')
            .select(({ fn }) => fn.countAll().as('n'))
            .where('org_id', '=', orgId)
            .where('household_id', 'in', householdIds)
            .where(
              'id',
              'not in',
              memberIds.length ? memberIds : [randomUUID()],
            )
            .executeTakeFirst();
          if (Number(strayMembers?.n ?? 0) > 0)
            throw new PeopleError(
              409,
              'CONFLICT',
              'Imported households have new members and cannot roll back',
            );
        }
        const now = new Date();
        if (linkIds.length > 0)
          await trx
            .updateTable('person_account_links')
            .set({ revoked_at: now })
            .where('org_id', '=', orgId)
            .where('id', 'in', linkIds)
            .where('revoked_at', 'is', null)
            .execute();
        if (contactIds.length > 0)
          await trx
            .updateTable('emergency_contacts')
            .set({ removed_at: now })
            .where('org_id', '=', orgId)
            .where('id', 'in', contactIds)
            .where('removed_at', 'is', null)
            .execute();
        if (memberIds.length > 0)
          await trx
            .updateTable('household_members')
            .set({ removed_at: now })
            .where('org_id', '=', orgId)
            .where('id', 'in', memberIds)
            .where('removed_at', 'is', null)
            .execute();
        if (personIds.length > 0)
          await trx
            .updateTable('people')
            .set({ status: 'archived', version: sql`version + 1` })
            .where('org_id', '=', orgId)
            .where('id', 'in', personIds)
            .where('status', '=', 'active')
            .execute();
        if (householdIds.length > 0)
          await trx
            .updateTable('households')
            .set({ status: 'archived', version: sql`version + 1` })
            .where('org_id', '=', orgId)
            .where('id', 'in', householdIds)
            .where('status', '=', 'active')
            .execute();
        for (const { row, snapshot } of snapshots) {
          const personId = row.entity_id as string;
          await trx
            .updateTable('people')
            .set({
              first_name: snapshot.first_name,
              last_name: snapshot.last_name,
              date_of_birth: snapshot.date_of_birth,
              email: snapshot.email,
              phone_e164: snapshot.phone_e164,
              gender: snapshot.gender,
              graduation_year: snapshot.graduation_year,
              school_name: snapshot.school_name,
              version: sql`version + 1`,
            })
            .where('org_id', '=', orgId)
            .where('id', '=', personId)
            .where('version', '=', snapshot.expectedVersion)
            .execute();
          await trx
            .insertInto('audit_log')
            .values({
              id: newId(),
              org_id: orgId,
              actor_account_id: actorId,
              action: 'person.import_rollback',
              entity_type: 'person',
              entity_id: personId,
              changes: { batchId },
            })
            .execute();
        }
        if (personIds.length > 0)
          await trx
            .insertInto('audit_log')
            .values(
              personIds.map((personId) => ({
                id: newId(),
                org_id: orgId,
                actor_account_id: actorId,
                action: 'person.import_rollback_archived',
                entity_type: 'person',
                entity_id: personId,
                changes: { batchId },
              })),
            )
            .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: actorId,
            action: 'import.batch_rolled_back',
            entity_type: 'import_batch',
            entity_id: batchId,
            changes: { kind: batch.kind, rows: rows.length },
          })
          .execute();
        await trx
          .updateTable('import_batches')
          .set({
            status: 'rolled_back',
            rolled_back_at: new Date(),
            rolled_back_by: actorId,
          })
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .execute();
        return toBatch({
          ...batch,
          status: 'rolled_back',
          rolled_back_at: new Date(),
        });
      });
    },

    async get(orgId: string, actorId: string, batchId: string) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const batch = await trx
          .selectFrom('import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new PeopleError(404, 'NOT_FOUND', 'Import batch not found');
        const rows = await trx
          .selectFrom('import_rows')
          .select(['row_number', 'action', 'issues', 'normalized'])
          .where('org_id', '=', orgId)
          .where('batch_id', '=', batchId)
          .orderBy('row_number')
          .execute();
        return {
          batch: toBatch(batch),
          rows: rows.map((row) => ({
            rowNumber: row.row_number,
            action: row.action,
            issues: (row.issues ?? []) as unknown as ImportRowIssue[],
            normalized: row.normalized as Record<string, unknown> | null,
          })),
        };
      });
    },

    async list(orgId: string, actorId: string) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const rows = await trx
          .selectFrom('import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .orderBy('created_at', 'desc')
          .limit(100)
          .execute();
        return { items: rows.map(toBatch) };
      });
    },

    async savePreset(
      orgId: string,
      actorId: string,
      input: {
        kind: ImportKind;
        name: string;
        mapping: Record<string, string>;
      },
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const id = newId();
        await trx
          .insertInto('import_mapping_presets')
          .values({
            id,
            org_id: orgId,
            kind: input.kind,
            name: input.name,
            mapping: input.mapping,
            created_by: actorId,
          })
          .onConflict((conflict) =>
            conflict
              .columns(['org_id', 'kind', 'name'])
              .doUpdateSet({ mapping: input.mapping }),
          )
          .execute();
        const saved = await trx
          .selectFrom('import_mapping_presets')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('kind', '=', input.kind)
          .where('name', '=', input.name)
          .executeTakeFirstOrThrow();
        return {
          id: saved.id,
          kind: saved.kind as ImportKind,
          name: saved.name,
          mapping: saved.mapping as Record<string, string>,
          createdAt: saved.created_at.toISOString(),
        };
      });
    },

    async listPresets(orgId: string, actorId: string, kind?: ImportKind) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        let query = trx
          .selectFrom('import_mapping_presets')
          .selectAll()
          .where('org_id', '=', orgId)
          .orderBy('name');
        if (kind !== undefined) query = query.where('kind', '=', kind);
        const rows = await query.execute();
        return {
          items: rows.map((row) => ({
            id: row.id,
            kind: row.kind as ImportKind,
            name: row.name,
            mapping: row.mapping as Record<string, string>,
            createdAt: row.created_at.toISOString(),
          })),
        };
      });
    },
  };

  function primaryType(kind: string): CreatedRef['type'] {
    if (kind === 'people') return 'person';
    if (kind === 'households') return 'household';
    if (kind === 'guardians') return 'person_account_link';
    return 'emergency_contact';
  }
}

type Trx = OrgTransaction;
type ImportRowRow = {
  id: string;
  row_number: number;
  action: string;
  normalized: unknown;
  target_person_id: string | null;
};

async function commitPeople(
  trx: Trx,
  orgId: string,
  actorId: string,
  batchId: string,
  rows: ImportRowRow[],
  refs: Map<number, CreatedRef[]>,
  beforeStates: Map<number, PersonImportSnapshot>,
) {
  const creates = rows.filter((row) => row.action === 'create');
  const updates = rows.filter(
    (row) => row.action === 'update' || row.action === 'merge',
  );
  const people = creates.map((row) => row.normalized as NormalizedPerson);
  const householdNames = [
    ...new Set(
      people
        .map((person) => person.householdName?.toLowerCase())
        .filter((name): name is string => name !== undefined && name !== ''),
    ),
  ];
  const [existingHouseholds, existingPeople] = await Promise.all([
    householdNames.length === 0
      ? Promise.resolve([])
      : trx
          .selectFrom('households')
          .select(['id', 'name'])
          .where('org_id', '=', orgId)
          .where('status', '=', 'active')
          .execute(),
    updates.length === 0
      ? Promise.resolve([])
      : trx
          .selectFrom('people')
          .select([
            'id',
            'email',
            'phone_e164',
            'first_name',
            'last_name',
            'date_of_birth',
            'gender',
            'graduation_year',
            'school_name',
            'version',
          ])
          .where('org_id', '=', orgId)
          .where('status', '=', 'active')
          .execute(),
  ]);
  const householdIdByName = new Map(
    existingHouseholds.map((household) => [
      household.name.toLowerCase(),
      household.id,
    ]),
  );
  const importedHouseholdIds = new Set<string>();
  const recordedHouseholdIds = new Set<string>();
  const missingNames = householdNames.filter(
    (name) => !householdIdByName.has(name),
  );
  if (missingNames.length > 0) {
    const originals = new Map(
      people.flatMap((person) => {
        const name = person.householdName;
        return name === null ? [] : [[name.toLowerCase(), name] as const];
      }),
    );
    const inserted = await trx
      .insertInto('households')
      .values(
        missingNames.map((name) => ({
          id: newId(),
          org_id: orgId,
          name: originals.get(name) ?? name,
        })),
      )
      .returning(['id', 'name'])
      .execute();
    for (const household of inserted) {
      householdIdByName.set(household.name.toLowerCase(), household.id);
      importedHouseholdIds.add(household.id);
    }
  }

  const inserts: Insertable<DB['people']>[] = people.map((person) => ({
    id: newId(),
    org_id: orgId,
    first_name: person.firstName,
    last_name: person.lastName,
    date_of_birth: person.dateOfBirth as string,
    email: person.email,
    phone_e164: person.phoneE164,
    gender: person.gender,
    graduation_year: person.graduationYear,
    school_name: person.schoolName,
  }));
  const createdIds: string[] = [];
  for (let index = 0; index < inserts.length; index += 500) {
    const chunk = inserts.slice(index, index + 500);
    const returned = await trx
      .insertInto('people')
      .values(chunk)
      .returning('id')
      .execute();
    createdIds.push(...returned.map((row) => row.id));
  }
  if (createdIds.length > 0)
    await trx
      .insertInto('audit_log')
      .values(
        creates.map((row, index) => ({
          id: newId(),
          org_id: orgId,
          actor_account_id: actorId,
          action: 'person.imported',
          entity_type: 'person',
          entity_id: createdIds[index] as string,
          changes: { batchId, rowNumber: row.row_number },
        })),
      )
      .execute();
  const memberInserts: Insertable<DB['household_members']>[] = [];
  const contactInserts: Insertable<DB['emergency_contacts']>[] = [];
  creates.forEach((row, index) => {
    const person = row.normalized as NormalizedPerson;
    const personId = createdIds[index] as string;
    const created: CreatedRef[] = [{ type: 'person', id: personId }];
    refs.set(row.row_number, created);
    if (person.householdName) {
      const householdId = householdIdByName.get(
        person.householdName.toLowerCase(),
      );
      if (householdId) {
        const memberId = newId();
        memberInserts.push({
          id: memberId,
          org_id: orgId,
          household_id: householdId,
          person_id: personId,
          role: 'athlete',
          is_primary_contact: false,
        });
        created.push({ type: 'household_member', id: memberId });
        if (
          importedHouseholdIds.has(householdId) &&
          !recordedHouseholdIds.has(householdId)
        ) {
          created.push({ type: 'household', id: householdId });
          recordedHouseholdIds.add(householdId);
        }
      }
    }
    if (person.emergencyContactName && person.emergencyContactPhoneE164) {
      const contactId = newId();
      contactInserts.push({
        id: contactId,
        org_id: orgId,
        person_id: personId,
        name: person.emergencyContactName,
        relationship: 'emergency contact',
        phone_e164: person.emergencyContactPhoneE164,
        priority: 1,
      });
      created.push({ type: 'emergency_contact', id: contactId });
    }
  });
  for (let index = 0; index < memberInserts.length; index += 500)
    await trx
      .insertInto('household_members')
      .values(memberInserts.slice(index, index + 500))
      .execute();
  for (let index = 0; index < contactInserts.length; index += 500)
    await trx
      .insertInto('emergency_contacts')
      .values(contactInserts.slice(index, index + 500))
      .execute();
  // Guardian access is granted only by the explicit guardian import flow,
  // which also creates the adult's self profile and household membership.

  for (const row of updates) {
    const person = row.normalized as NormalizedPerson;
    const target =
      (row.target_person_id &&
        existingPeople.find(
          (existing) => existing.id === row.target_person_id,
        )) ||
      (person.email &&
        existingPeople.find(
          (existing) => existing.email?.toLowerCase() === person.email,
        )) ||
      (person.phoneE164 &&
        existingPeople.find(
          (existing) => existing.phone_e164 === person.phoneE164,
        )) ||
      existingPeople.find(
        (existing) =>
          personNameDobKey(
            existing.first_name,
            existing.last_name,
            dobKey(existing.date_of_birth),
          ) ===
          personNameDobKey(
            person.firstName,
            person.lastName,
            person.dateOfBirth,
          ),
      );
    if (target == null) continue;
    const targetId = target.id;
    const snapshot: PersonImportSnapshot = {
      expectedVersion: target.version + 1,
      first_name: target.first_name,
      last_name: target.last_name,
      date_of_birth: dobKey(target.date_of_birth),
      email: target.email,
      phone_e164: target.phone_e164,
      gender: target.gender as PersonImportSnapshot['gender'],
      graduation_year: target.graduation_year,
      school_name: target.school_name,
    };
    beforeStates.set(row.row_number, snapshot);
    const merging = row.action === 'merge';
    const updated = await trx
      .updateTable('people')
      .set({
        first_name: merging ? target.first_name : person.firstName,
        last_name: merging ? target.last_name : person.lastName,
        date_of_birth: merging
          ? target.date_of_birth
          : (person.dateOfBirth as string),
        phone_e164: merging
          ? (target.phone_e164 ?? person.phoneE164)
          : (person.phoneE164 ?? undefined),
        email: merging
          ? (target.email ?? person.email)
          : (person.email ?? undefined),
        gender:
          merging && target.gender !== 'unspecified'
            ? target.gender
            : person.gender,
        graduation_year: merging
          ? (target.graduation_year ?? person.graduationYear)
          : (person.graduationYear ?? undefined),
        school_name: merging
          ? (target.school_name ?? person.schoolName)
          : (person.schoolName ?? undefined),
        version: sql`version + 1`,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', targetId)
      .where('version', '=', target.version)
      .returning('version')
      .executeTakeFirst();
    if (!updated)
      throw new PeopleError(409, 'CONFLICT', 'Person changed during import');
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: orgId,
        actor_account_id: actorId,
        action: 'person.import_updated',
        entity_type: 'person',
        entity_id: targetId,
        changes: {
          batchId,
          rowNumber: row.row_number,
          version: updated.version,
        },
      })
      .execute();
    refs.set(row.row_number, [{ type: 'person', id: targetId }]);
  }
}

async function commitHouseholds(
  trx: Trx,
  orgId: string,
  rows: ImportRowRow[],
  refs: Map<number, CreatedRef[]>,
) {
  for (const row of rows) {
    if (row.action !== 'create') continue;
    const household = row.normalized as NormalizedHousehold;
    const id = newId();
    await trx
      .insertInto('households')
      .values({ id, org_id: orgId, name: household.name as string })
      .execute();
    refs.set(row.row_number, [{ type: 'household', id }]);
  }
}

async function commitGuardians(
  trx: Trx,
  orgId: string,
  actorId: string,
  rows: ImportRowRow[],
  refs: Map<number, CreatedRef[]>,
) {
  const creates = rows.filter((row) => row.action === 'create');
  const emails = [
    ...new Set(
      creates
        .map((row) => (row.normalized as NormalizedGuardian).guardianEmail)
        .filter((email): email is string => email !== null),
    ),
  ];
  const accounts =
    emails.length === 0
      ? []
      : await trx
          .selectFrom('accounts')
          .select([
            'id',
            'email',
            'date_of_birth',
            'email_verified_at',
            'status',
          ])
          .where('email', 'in', emails)
          .execute();
  const accountByEmail = new Map(
    accounts.map((account) => [account.email.toLowerCase(), account.id]),
  );
  const people = await trx
    .selectFrom('people')
    .select(['id', 'first_name', 'last_name', 'date_of_birth', 'email'])
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .execute();
  const personByEmail = new Map(
    people.flatMap((person) =>
      person.email === null
        ? []
        : [[person.email.toLowerCase(), person.id] as const],
    ),
  );
  const personByNameDob = new Map(
    people.map((p) => [
      personNameDobKey(p.first_name, p.last_name, dobKey(p.date_of_birth)),
      p.id,
    ]),
  );
  for (const row of creates) {
    const guardian = row.normalized as NormalizedGuardian;
    const personId =
      (guardian.personEmail && personByEmail.get(guardian.personEmail)) ||
      personByNameDob.get(
        personNameDobKey(
          guardian.personFirstName,
          guardian.personLastName,
          guardian.personDateOfBirth,
        ),
      );
    const accountId =
      guardian.guardianEmail && accountByEmail.get(guardian.guardianEmail);
    if (!personId || !accountId)
      throw new PeopleError(
        400,
        'VALIDATION_ERROR',
        `Guardian or person was not found for import row ${String(row.row_number)}`,
      );
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (
      !account ||
      account.status !== 'active' ||
      account.email_verified_at === null
    )
      throw new PeopleError(
        400,
        'VALIDATION_ERROR',
        `Guardian account for import row ${String(row.row_number)} is not verified and active`,
      );
    const existingLink = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', orgId)
      .where('person_id', '=', personId)
      .where('account_id', '=', accountId)
      .where('relationship', '=', 'guardian')
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (existingLink)
      throw new PeopleError(
        409,
        'CONFLICT',
        `Guardian is already linked for import row ${String(row.row_number)}`,
      );
    const guardianProfile = await ensureGuardianProfileAndHousehold(
      trx,
      orgId,
      accountId,
      personId,
      actorId,
    );
    const id = newId();
    const inserted = await trx
      .insertInto('person_account_links')
      .values({
        id,
        org_id: orgId,
        person_id: personId,
        account_id: accountId,
        relationship: 'guardian',
        verified_at: new Date(),
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning('id')
      .execute();
    if (inserted.length === 0)
      throw new PeopleError(
        409,
        'CONFLICT',
        `Guardian link changed during import row ${String(row.row_number)}`,
      );
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: orgId,
        actor_account_id: actorId,
        action: 'person.guardian_linked',
        entity_type: 'person',
        entity_id: personId,
        changes: { linkId: id, importRow: row.row_number },
      })
      .execute();
    refs.set(row.row_number, [
      { type: 'person_account_link', id },
      ...guardianProfile.createdRefs,
    ]);
  }
}

async function commitContacts(
  trx: Trx,
  orgId: string,
  rows: ImportRowRow[],
  refs: Map<number, CreatedRef[]>,
) {
  const creates = rows.filter((row) => row.action === 'create');
  const people = await trx
    .selectFrom('people')
    .select(['id', 'first_name', 'last_name', 'date_of_birth', 'email'])
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .execute();
  const personByEmail = new Map(
    people.flatMap((person) =>
      person.email === null
        ? []
        : [[person.email.toLowerCase(), person.id] as const],
    ),
  );
  const personByNameDob = new Map(
    people.map((p) => [
      personNameDobKey(p.first_name, p.last_name, dobKey(p.date_of_birth)),
      p.id,
    ]),
  );
  for (const row of creates) {
    const contact = row.normalized as NormalizedEmergencyContact;
    const personId =
      (contact.personEmail && personByEmail.get(contact.personEmail)) ||
      personByNameDob.get(
        personNameDobKey(
          contact.personFirstName,
          contact.personLastName,
          contact.personDateOfBirth,
        ),
      );
    if (!personId) continue;
    const id = newId();
    await trx
      .insertInto('emergency_contacts')
      .values({
        id,
        org_id: orgId,
        person_id: personId,
        name: contact.name,
        relationship: contact.relationship,
        phone_e164: contact.phoneE164 as string,
        priority: contact.priority,
      })
      .execute();
    refs.set(row.row_number, [{ type: 'emergency_contact', id }]);
  }
}

async function countTouchedPeople(
  trx: Trx,
  orgId: string,
  personIds: string[],
  created: { memberIds: string[]; contactIds: string[]; linkIds: string[] },
): Promise<number> {
  const empty = [randomUUID()];
  const memberIds = created.memberIds.length ? created.memberIds : empty;
  const contactIds = created.contactIds.length ? created.contactIds : empty;
  const linkIds = created.linkIds.length ? created.linkIds : empty;
  const result = await trx
    .selectFrom('people')
    .select(({ fn }) => fn.countAll().as('n'))
    .where('org_id', '=', orgId)
    .where('id', 'in', personIds)
    .where((eb) =>
      eb.or([
        eb('version', '>', 1),
        eb('merged_into_id', 'is not', null),
        eb('status', '!=', 'active'),
        eb.exists(
          eb
            .selectFrom('registrations')
            .select('id')
            .where('org_id', '=', orgId)
            .whereRef('person_id', '=', 'people.id'),
        ),
        eb.exists(
          eb
            .selectFrom('attendance')
            .select('id')
            .where('org_id', '=', orgId)
            .whereRef('person_id', '=', 'people.id'),
        ),
        eb.exists(
          eb
            .selectFrom('roster_entries')
            .select('id')
            .where('org_id', '=', orgId)
            .whereRef('person_id', '=', 'people.id'),
        ),
        eb.exists(
          eb
            .selectFrom('medical_profiles')
            .select('id')
            .where('org_id', '=', orgId)
            .whereRef('person_id', '=', 'people.id'),
        ),
        eb.exists(
          eb
            .selectFrom('waiver_signatures')
            .select('id')
            .where('org_id', '=', orgId)
            .where((inner) =>
              inner.or([
                inner('participant_person_id', '=', eb.ref('people.id')),
                inner('signer_person_id', '=', eb.ref('people.id')),
              ]),
            ),
        ),
        eb.exists(
          eb
            .selectFrom('person_credentials')
            .select('id')
            .where('org_id', '=', orgId)
            .whereRef('person_id', '=', 'people.id'),
        ),
        eb.exists(
          eb
            .selectFrom('person_account_links')
            .select('id')
            .where('org_id', '=', orgId)
            .whereRef('person_id', '=', 'people.id')
            .where('id', 'not in', linkIds),
        ),
        eb.exists(
          eb
            .selectFrom('household_members')
            .select('id')
            .where('org_id', '=', orgId)
            .whereRef('person_id', '=', 'people.id')
            .where('id', 'not in', memberIds),
        ),
        eb.exists(
          eb
            .selectFrom('emergency_contacts')
            .select('id')
            .where('org_id', '=', orgId)
            .whereRef('person_id', '=', 'people.id')
            .where('id', 'not in', contactIds),
        ),
        eb.exists(
          eb
            .selectFrom('form_responses')
            .select('id')
            .where('org_id', '=', orgId)
            .where('subject_type', '=', 'person')
            .whereRef('subject_id', '=', 'people.id'),
        ),
      ]),
    )
    .executeTakeFirst();
  return Number(result?.n ?? 0);
}
