import { newId } from '@shared/ids';
import type {
  ImportDuplicate,
  ImportIssue,
  ImportKind,
} from '@shared/schemas/imports';
import { sql } from 'kysely';

import type { JsonObject } from '../../db/types';
import type { OrgTransaction } from '../../db/withOrg';
import type { EncryptionKeys } from '../../lib/crypto';
import { encryptRestricted } from '../../lib/crypto';

import { findDuplicateCandidates } from './duplicates';
import {
  issue,
  parseBool,
  parseDate,
  parseEnum,
  parseGender,
  parseInt_,
  parseList,
  parseMoney,
  parsePhone,
  parseTime,
} from './normalize';
import { parseEmail } from './normalize';
import {
  accountForPerson,
  ensureHousehold,
  findDivision,
  findFacility,
  findOffering,
  findPerson,
  findProgram,
  findSpace,
  findTeamSeason,
  primaryHousehold,
} from './resolve';

export interface CommitContext {
  orgId: string;
  actorId: string;
  encryption: EncryptionKeys | null;
  documents?: Map<string, { bytes: Uint8Array; mime: string }> | undefined;
  createFile?:
    | ((input: {
        name: string;
        mime: string;
        bytes: Uint8Array;
        ownerType: string;
        ownerId: string;
      }) => Promise<string>)
    | undefined;
}

export interface RowOutcome {
  targets: { table: string; id: string; version: number | null }[];
  note?: string;
}

export interface KindDefinition {
  normalize(
    trx: OrgTransaction,
    ctx: CommitContext,
    values: Record<string, string>,
  ):
    | {
        normalized: Record<string, unknown>;
        issues: ImportIssue[];
        duplicates: ImportDuplicate[];
      }
    | Promise<{
        normalized: Record<string, unknown>;
        issues: ImportIssue[];
        duplicates: ImportDuplicate[];
      }>;
  commit(
    trx: OrgTransaction,
    ctx: CommitContext,
    rows: { rowId: string; normalized: Record<string, unknown> }[],
  ): Promise<{
    outcomes: Map<string, RowOutcome>;
    summary: Record<string, unknown>;
  }>;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}

function bool(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

function requireText(
  values: Record<string, string>,
  key: string,
  label: string,
  issues: ImportIssue[],
): string | null {
  const value = values[key]?.trim();
  if (!value) {
    issues.push(issue('error', 'REQUIRED', `${label} is required`, key));
    return null;
  }
  return value;
}

function applyAddress(record: Record<string, unknown>): JsonObject | null {
  const line1 = str(record, 'address_line1');
  const city = str(record, 'city');
  const region = str(record, 'state');
  const postal = str(record, 'postal_code');
  const line2 = str(record, 'address_line2');
  if (!line1 && !city && !region && !postal && !line2) return null;
  const address: JsonObject = {};
  if (line1) address['line1'] = line1;
  if (line2) address['line2'] = line2;
  if (city) address['city'] = city;
  if (region) address['region'] = region;
  if (postal) address['postalCode'] = postal;
  return address;
}

// ---------- people ----------

async function normalizePerson(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const first = requireText(values, 'first_name', 'First name', issues);
  const last = requireText(values, 'last_name', 'Last name', issues);
  if (first) normalized['first_name'] = first;
  if (last) normalized['last_name'] = last;
  for (const key of [
    'preferred_name',
    'middle_name',
    'suffix',
    'school_name',
  ] as const) {
    const value = values[key]?.trim();
    if (value) normalized[key] = value;
  }
  for (const [key, parser] of [
    ['date_of_birth', parseDate],
    ['phone', parsePhone],
    ['email', parseEmail],
    ['graduation_year', parseInt_],
  ] as const) {
    const raw = values[key] ?? '';
    if (!raw.trim()) continue;
    const { value, issue: found } = parser(raw, key);
    if (found) issues.push(found);
    if (value !== null) normalized[key] = value;
  }
  const genderRaw = values['gender'] ?? '';
  if (genderRaw.trim()) {
    const { value, issue: found } = parseGender(genderRaw, 'gender');
    if (found) issues.push(found);
    if (value) normalized['gender'] = value;
  }
  for (const key of [
    'address_line1',
    'address_line2',
    'city',
    'state',
    'postal_code',
    'household_name',
    'ec_name',
    'ec_note',
  ] as const) {
    const value = values[key]?.trim();
    if (value) normalized[key] = value;
  }
  const roleRaw = values['member_role']?.trim();
  if (roleRaw) {
    const roleAliases: Record<string, string> = {
      player: 'athlete',
      parent: 'guardian',
      mom: 'guardian',
      dad: 'guardian',
      child: 'other_child',
      adult: 'other_adult',
    };
    const role = parseEnum(
      roleAliases[roleRaw.toLowerCase()] ?? roleRaw.toLowerCase(),
      'member_role',
      ['guardian', 'athlete', 'other_adult', 'other_child'],
    );
    if (role.issue) issues.push(role.issue);
    if (role.value) normalized['member_role'] = role.value;
  }
  const ecPhone = values['ec_phone']?.trim();
  if (ecPhone) {
    const { value, issue: found } = parsePhone(ecPhone, 'ec_phone');
    if (found) issues.push(found);
    if (value) normalized['ec_phone'] = value;
  }
  if (normalized['ec_name'] && !normalized['ec_phone'])
    issues.push(
      issue(
        'warning',
        'EC_PHONE_MISSING',
        'Emergency contact has no usable phone; it will not be imported',
        'ec_phone',
      ),
    );
  const duplicates = issues.some((entry) => entry.level === 'error')
    ? []
    : await findDuplicateCandidates(trx, ctx.orgId, {
        first: first ?? '',
        last: last ?? '',
        dob: (normalized['date_of_birth'] as string | undefined) ?? null,
        email: (normalized['email'] as string | undefined) ?? null,
        phone: (normalized['phone'] as string | undefined) ?? null,
      });
  return { normalized, issues, duplicates };
}

async function commitPeople(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  const householdsByName = new Map<string, string>();
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const record = row.normalized;
    const action =
      row.action === 'update' || row.action === 'merge'
        ? 'update'
        : row.action === 'skip'
          ? 'skip'
          : 'create';
    if (action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    if (action === 'update') {
      const target = row.targetId;
      if (!target) {
        outcomes.set(row.rowId, { targets: [], note: 'no merge target' });
        continue;
      }
      const sets: Record<string, unknown> = {};
      for (const key of [
        'first_name',
        'last_name',
        'preferred_name',
        'middle_name',
        'suffix',
        'email',
        'school_name',
        'graduation_year',
        'gender',
      ]) {
        if (record[key] !== undefined) sets[key] = record[key];
      }
      if (record['phone'] !== undefined) sets['phone_e164'] = record['phone'];
      const address = applyAddress(record);
      if (address) sets['address'] = address;
      if (record['date_of_birth'])
        sets['date_of_birth'] = record['date_of_birth'];
      const result = await sql<{ version: number }>`
        UPDATE people SET ${sql.join(
          Object.entries(sets).map(
            ([key, value]) => sql`${sql.ref(key)} = ${value}`,
          ),
          sql`, `,
        )}, version = version + 1
        WHERE org_id = ${ctx.orgId} AND id = ${target}
        RETURNING version
      `.execute(trx);
      outcomes.set(row.rowId, {
        targets: [
          {
            table: 'people',
            id: target,
            version: result.rows[0]?.version ?? null,
          },
        ],
      });
      updated += 1;
      continue;
    }
    const id = newId();
    await trx
      .insertInto('people')
      .values({
        id,
        org_id: ctx.orgId,
        first_name: str(record, 'first_name') ?? '',
        last_name: str(record, 'last_name') ?? '',
        ...(record['preferred_name']
          ? { preferred_name: str(record, 'preferred_name') }
          : {}),
        ...(record['middle_name']
          ? { middle_name: str(record, 'middle_name') }
          : {}),
        ...(record['suffix'] ? { suffix: str(record, 'suffix') } : {}),
        date_of_birth: str(record, 'date_of_birth') ?? '1900-01-01',
        gender: str(record, 'gender') ?? 'unspecified',
        ...(record['email'] ? { email: str(record, 'email') } : {}),
        ...(record['phone'] ? { phone_e164: str(record, 'phone') } : {}),
        ...(applyAddress(record) ? { address: applyAddress(record) } : {}),
        ...(record['graduation_year']
          ? { graduation_year: num(record, 'graduation_year') }
          : {}),
        ...(record['school_name']
          ? { school_name: str(record, 'school_name') }
          : {}),
      })
      .execute();
    const targets: RowOutcome['targets'] = [
      { table: 'people', id, version: 1 },
    ];
    const householdName = str(record, 'household_name');
    if (householdName) {
      let householdId =
        householdsByName.get(householdName.toLowerCase()) ?? null;
      if (!householdId) {
        const existing = await trx
          .selectFrom('households')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where(sql<boolean>`lower(name) = lower(${householdName})`)
          .executeTakeFirst();
        if (existing) {
          householdId = existing.id;
        } else {
          householdId = newId();
          await trx
            .insertInto('households')
            .values({ id: householdId, org_id: ctx.orgId, name: householdName })
            .execute();
          targets.push({ table: 'households', id: householdId, version: 1 });
        }
        householdsByName.set(householdName.toLowerCase(), householdId);
      }
      const memberId = newId();
      await trx
        .insertInto('household_members')
        .values({
          id: memberId,
          org_id: ctx.orgId,
          household_id: householdId,
          person_id: id,
          role: str(record, 'member_role') ?? 'guardian',
        })
        .execute();
      targets.push({ table: 'household_members', id: memberId, version: null });
    }
    const ecName = str(record, 'ec_name');
    const ecPhone = str(record, 'ec_phone');
    if (ecName && ecPhone) {
      const ecId = newId();
      await trx
        .insertInto('emergency_contacts')
        .values({
          id: ecId,
          org_id: ctx.orgId,
          person_id: id,
          name: ecName,
          phone_e164: ecPhone,
          relationship: 'emergency',
          priority: 1,
        })
        .execute();
      targets.push({ table: 'emergency_contacts', id: ecId, version: null });
    }
    outcomes.set(row.rowId, { targets });
    created += 1;
  }
  return { outcomes, summary: { created, updated } };
}

// ---------- households ----------

async function normalizeHousehold(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const name = requireText(values, 'household_name', 'Household name', issues);
  const first = requireText(
    values,
    'member_first_name',
    'Member first name',
    issues,
  );
  const last = requireText(
    values,
    'member_last_name',
    'Member last name',
    issues,
  );
  const role = values['member_role']?.trim()
    ? parseEnum(values['member_role'], 'member_role', [
        'guardian',
        'athlete',
        'other_adult',
        'other_child',
      ])
    : {
        value: null,
        issue: issue(
          'error',
          'REQUIRED',
          'Member role is required',
          'member_role',
        ),
      };
  if (role.issue) issues.push(role.issue);
  if (name) normalized['household_name'] = name;
  if (first) normalized['member_first_name'] = first;
  if (last) normalized['member_last_name'] = last;
  if (role.value) normalized['member_role'] = role.value;
  const email = values['member_email']?.trim()
    ? parseEmail(values['member_email'], 'member_email')
    : { value: null, issue: null };
  if (email.issue) issues.push(email.issue);
  if (email.value) normalized['member_email'] = email.value;
  const dob = values['member_dob']?.trim()
    ? parseDate(values['member_dob'], 'member_dob')
    : { value: null, issue: null };
  if (dob.issue) issues.push(dob.issue);
  if (dob.value) normalized['member_dob'] = dob.value;
  for (const key of [
    'financially_responsible',
    'is_primary_contact',
    'can_pick_up',
  ] as const) {
    const raw = values[key];
    if (!raw?.trim()) continue;
    const { value, issue: found } = parseBool(raw, key);
    if (found) issues.push(found);
    if (value !== null) normalized[key] = value;
  }
  for (const key of [
    'address_line1',
    'city',
    'state',
    'postal_code',
  ] as const) {
    const value = values[key]?.trim();
    if (value) normalized[key] = value;
  }
  if (email.value) {
    const { match, ambiguous } = await findPerson(trx, ctx.orgId, {
      email: email.value,
    });
    if (ambiguous)
      issues.push(
        issue(
          'warning',
          'AMBIGUOUS_PERSON',
          'Multiple people share this email',
          'member_email',
        ),
      );
    if (match) normalized['_person_id'] = match.id;
  }
  return { normalized, issues, duplicates: [] };
}

async function commitHouseholds(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  const households = new Map<string, string>();
  let created = 0;
  let members = 0;
  let peopleCreated = 0;
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const name = str(record, 'household_name') ?? '';
    let householdId = households.get(name.toLowerCase()) ?? null;
    const targets: RowOutcome['targets'] = [];
    if (!householdId) {
      const existing = await trx
        .selectFrom('households')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where(sql<boolean>`lower(name) = lower(${name})`)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (existing) {
        householdId = existing.id;
      } else {
        householdId = newId();
        await trx
          .insertInto('households')
          .values({
            id: householdId,
            org_id: ctx.orgId,
            name,
            address: applyAddress(record),
          })
          .execute();
        targets.push({ table: 'households', id: householdId, version: 1 });
        created += 1;
      }
      households.set(name.toLowerCase(), householdId);
    }
    let personId = str(record, '_person_id');
    if (!personId) {
      personId = newId();
      await trx
        .insertInto('people')
        .values({
          id: personId,
          org_id: ctx.orgId,
          first_name: str(record, 'member_first_name') ?? '',
          last_name: str(record, 'member_last_name') ?? '',
          date_of_birth: str(record, 'member_dob') ?? '1900-01-01',
          email: str(record, 'member_email'),
        })
        .execute();
      targets.push({ table: 'people', id: personId, version: 1 });
      peopleCreated += 1;
    }
    const memberId = newId();
    await trx
      .insertInto('household_members')
      .values({
        id: memberId,
        org_id: ctx.orgId,
        household_id: householdId,
        person_id: personId,
        role: str(record, 'member_role') ?? 'other_adult',
        financially_responsible:
          bool(record, 'financially_responsible') ?? false,
        is_primary_contact: bool(record, 'is_primary_contact') ?? false,
        can_pick_up: bool(record, 'can_pick_up') ?? false,
      })
      .execute();
    targets.push({ table: 'household_members', id: memberId, version: null });
    members += 1;
    outcomes.set(row.rowId, { targets });
  }
  return {
    outcomes,
    summary: {
      households_created: created,
      members_added: members,
      people_created: peopleCreated,
    },
  };
}

// ---------- registrations (history) ----------

const REGISTRATION_STATUSES = ['confirmed', 'canceled', 'withdrawn'] as const;

async function normalizeRegistration(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const email = values['person_email']?.trim()
    ? parseEmail(values['person_email'], 'person_email')
    : { value: null, issue: null };
  if (email.issue) issues.push(email.issue);
  const first = values['first_name']?.trim() ?? '';
  const last = values['last_name']?.trim() ?? '';
  const dob = values['date_of_birth']?.trim()
    ? parseDate(values['date_of_birth'], 'date_of_birth')
    : { value: null, issue: null };
  if (dob.issue) issues.push(dob.issue);
  if (!email.value && !first)
    issues.push(
      issue(
        'error',
        'REQUIRED',
        'Provide a participant email or first name',
        'first_name',
      ),
    );
  if (!email.value && !last)
    issues.push(
      issue(
        'error',
        'REQUIRED',
        'Provide a participant email or last name',
        'last_name',
      ),
    );
  const person = await findPerson(trx, ctx.orgId, {
    email: email.value,
    first,
    last,
    dob: dob.value,
  });
  if (person.ambiguous)
    issues.push(
      issue(
        'error',
        'AMBIGUOUS_PERSON',
        'More than one person matches; add an email column to disambiguate',
        'person_email',
      ),
    );
  if (!person.match && !person.ambiguous)
    issues.push(
      issue(
        'error',
        'PERSON_NOT_FOUND',
        'No matching person; import people first',
        'person_email',
      ),
    );
  if (person.match) normalized['_person_id'] = person.match.id;
  const programName = requireText(values, 'program', 'Program', issues);
  if (programName) {
    const program = await findProgram(trx, ctx.orgId, programName);
    if (!program) {
      issues.push(
        issue(
          'error',
          'PROGRAM_NOT_FOUND',
          `No program named "${programName}"`,
          'program',
        ),
      );
    } else {
      normalized['_program_id'] = program.id;
      const division = await findDivision(
        trx,
        ctx.orgId,
        program.id,
        values['division']?.trim() || null,
      );
      if (!division)
        issues.push(
          issue(
            'error',
            'DIVISION_NOT_FOUND',
            `No division "${values['division'] ?? ''}" in ${program.name}`,
            'division',
          ),
        );
      else normalized['_division_id'] = division.id;
      const offering = await findOffering(
        trx,
        ctx.orgId,
        program.id,
        values['offering']?.trim() || null,
      );
      if (!offering)
        issues.push(
          issue(
            'error',
            'OFFERING_NOT_FOUND',
            `No offering "${values['offering'] ?? ''}" in ${program.name}`,
            'offering',
          ),
        );
      else normalized['_offering_id'] = offering.id;
    }
  }
  const status = values['status']?.trim()
    ? parseEnum(values['status'], 'status', REGISTRATION_STATUSES)
    : { value: 'confirmed', issue: null };
  if (status.issue) issues.push(status.issue);
  normalized['status'] = status.value ?? 'confirmed';
  if (values['registered_on']?.trim()) {
    const parsed = parseDate(values['registered_on'], 'registered_on');
    if (parsed.issue) issues.push(parsed.issue);
    if (parsed.value) normalized['registered_on'] = parsed.value;
  }
  if (values['team']?.trim()) normalized['team'] = values['team'].trim();
  return { normalized, issues, duplicates: [] };
}

async function commitRegistrations(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  let created = 0;
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const personId = str(record, '_person_id');
    const programId = str(record, '_program_id');
    if (!personId || !programId) {
      outcomes.set(row.rowId, { targets: [], note: 'unresolved references' });
      continue;
    }
    const duplicate = await trx
      .selectFrom('registrations')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('program_id', '=', programId)
      .where('person_id', '=', personId)
      .where('status', 'not in', ['canceled', 'withdrawn', 'transferred_out'])
      .executeTakeFirst();
    if (duplicate) {
      outcomes.set(row.rowId, { targets: [], note: 'already registered' });
      continue;
    }
    const person = await trx
      .selectFrom('people')
      .select(['id', 'first_name', 'last_name', 'email'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', personId)
      .executeTakeFirstOrThrow();
    const householdId = await ensureHousehold(trx, ctx.orgId, person);
    let teamSeasonId: string | null = null;
    const teamName = str(record, 'team');
    if (teamName) {
      teamSeasonId =
        (await findTeamSeason(trx, ctx.orgId, teamName, programId))
          ?.teamSeasonId ?? null;
    }
    const divisionId = str(record, '_division_id');
    const offeringId = str(record, '_offering_id');
    if (!divisionId || !offeringId) {
      outcomes.set(row.rowId, {
        targets: [],
        note: 'unresolved division or offering',
      });
      continue;
    }
    const id = newId();
    await trx
      .insertInto('registrations')
      .values({
        id,
        org_id: ctx.orgId,
        program_id: programId,
        division_id: divisionId,
        offering_id: offeringId,
        person_id: personId,
        household_id: householdId,
        registered_by_account_id: ctx.actorId,
        source: 'import',
        status: str(record, 'status') ?? 'confirmed',
        team_season_id: teamSeasonId,
      })
      .execute();
    outcomes.set(row.rowId, {
      targets: [{ table: 'registrations', id, version: 1 }],
    });
    created += 1;
  }
  return { outcomes, summary: { created } };
}

// ---------- teams ----------

async function normalizeTeam(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const name = requireText(values, 'name', 'Team name', issues);
  if (name) normalized['name'] = name;
  for (const key of ['short_name', 'age_label'] as const) {
    const value = values[key]?.trim();
    if (value) normalized[key] = value;
  }
  const year = values['birth_year']?.trim()
    ? parseInt_(values['birth_year'], 'birth_year')
    : { value: null, issue: null };
  if (year.issue) issues.push(year.issue);
  if (year.value) normalized['birth_year'] = year.value;
  for (const [key, allowed] of [
    [
      'level',
      ['recreational', 'developmental', 'competitive', 'elite', 'open'],
    ],
    ['competition_gender', ['female', 'male', 'open']],
  ] as const) {
    const raw = values[key];
    if (!raw?.trim()) continue;
    const { value, issue: found } = parseEnum(raw, key, allowed);
    if (found) issues.push(found);
    if (value) normalized[key] = value;
  }
  const programName = values['program']?.trim();
  if (programName) {
    const program = await findProgram(trx, ctx.orgId, programName);
    if (!program)
      issues.push(
        issue(
          'error',
          'PROGRAM_NOT_FOUND',
          `No program named "${programName}"`,
          'program',
        ),
      );
    else {
      normalized['_program_id'] = program.id;
      normalized['_sport_profile_id'] = program.sport_profile_id;
      const division = await findDivision(
        trx,
        ctx.orgId,
        program.id,
        values['division']?.trim() || null,
      );
      if (!division)
        issues.push(
          issue(
            'error',
            'DIVISION_NOT_FOUND',
            `No division "${values['division'] ?? ''}" in ${program.name}`,
            'division',
          ),
        );
      else normalized['_division_id'] = division.id;
    }
  }
  return { normalized, issues, duplicates: [] };
}

async function commitTeams(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  let teamsCreated = 0;
  let seasonsCreated = 0;
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const name = str(record, 'name') ?? '';
    const targets: RowOutcome['targets'] = [];
    let teamId: string | null = null;
    const existing = await trx
      .selectFrom('teams')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (existing) {
      teamId = existing.id;
    } else {
      let sportProfileId = str(record, '_sport_profile_id');
      if (!sportProfileId) {
        const fallback = await trx
          .selectFrom('sport_profiles')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('archived_at', 'is', null)
          .orderBy('created_at')
          .limit(1)
          .executeTakeFirst();
        sportProfileId = fallback?.id ?? null;
      }
      if (!sportProfileId) {
        outcomes.set(row.rowId, {
          targets: [],
          note: 'no sport profile — add one before importing teams',
        });
        continue;
      }
      teamId = newId();
      await trx
        .insertInto('teams')
        .values({
          id: teamId,
          org_id: ctx.orgId,
          name,
          sport_profile_id: sportProfileId,
          short_name: str(record, 'short_name'),
          age_label: str(record, 'age_label'),
          birth_year: num(record, 'birth_year'),
          competition_gender: str(record, 'competition_gender'),
          level: str(record, 'level') ?? undefined,
        })
        .execute();
      targets.push({ table: 'teams', id: teamId, version: 1 });
      teamsCreated += 1;
    }
    const programId = str(record, '_program_id');
    const divisionId = str(record, '_division_id');
    if (programId && divisionId) {
      const existingSeason = await trx
        .selectFrom('team_seasons')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('team_id', '=', teamId)
        .where('program_id', '=', programId)
        .executeTakeFirst();
      if (!existingSeason) {
        const teamSeasonId = newId();
        await trx
          .insertInto('team_seasons')
          .values({
            id: teamSeasonId,
            org_id: ctx.orgId,
            team_id: teamId,
            program_id: programId,
            division_id: divisionId,
          })
          .execute();
        targets.push({ table: 'team_seasons', id: teamSeasonId, version: 1 });
        seasonsCreated += 1;
      } else {
        targets.push({
          table: 'team_seasons',
          id: existingSeason.id,
          version: null,
        });
      }
    }
    outcomes.set(row.rowId, { targets });
  }
  return {
    outcomes,
    summary: {
      teams_created: teamsCreated,
      team_seasons_created: seasonsCreated,
    },
  };
}

// ---------- rosters ----------

const STAFF_ROLES = [
  'head_coach',
  'assistant_coach',
  'team_manager',
  'trainer',
  'treasurer',
] as const;
const ROSTER_KINDS = ['player', 'rostered', 'guest', 'practice_only'] as const;

async function normalizeRoster(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const teamName = requireText(values, 'team', 'Team name', issues);
  let programId: string | null = null;
  const programName = values['program']?.trim();
  if (programName) {
    const program = await findProgram(trx, ctx.orgId, programName);
    if (!program)
      issues.push(
        issue(
          'error',
          'PROGRAM_NOT_FOUND',
          `No program named "${programName}"`,
          'program',
        ),
      );
    else programId = program.id;
  }
  if (teamName) {
    const teamSeason = await findTeamSeason(
      trx,
      ctx.orgId,
      teamName,
      programId,
    );
    if (!teamSeason)
      issues.push(
        issue(
          'error',
          'TEAM_NOT_FOUND',
          `No team season named "${teamName}"${programName ? ` in ${programName}` : ''}`,
          'team',
        ),
      );
    else normalized['_team_season_id'] = teamSeason.teamSeasonId;
  }
  const email = values['person_email']?.trim()
    ? parseEmail(values['person_email'], 'person_email')
    : { value: null, issue: null };
  if (email.issue) issues.push(email.issue);
  const first = values['first_name']?.trim() ?? '';
  const last = values['last_name']?.trim() ?? '';
  const dob = values['date_of_birth']?.trim()
    ? parseDate(values['date_of_birth'], 'date_of_birth')
    : { value: null, issue: null };
  if (dob.issue) issues.push(dob.issue);
  if (!email.value && (!first || !last))
    issues.push(
      issue(
        'error',
        'REQUIRED',
        'Provide the person email or first and last name',
        'person_email',
      ),
    );
  const person = await findPerson(trx, ctx.orgId, {
    email: email.value,
    first,
    last,
    dob: dob.value,
  });
  if (person.ambiguous)
    issues.push(
      issue(
        'error',
        'AMBIGUOUS_PERSON',
        'More than one person matches; add an email column',
        'person_email',
      ),
    );
  if (!person.match && !person.ambiguous && (email.value || first)) {
    normalized['_create_person'] = {
      first_name: first || 'Unknown',
      last_name: last || 'Unknown',
      email: email.value,
      date_of_birth: dob.value ?? null,
    };
  } else if (person.match) {
    normalized['_person_id'] = person.match.id;
  }
  const role = values['role']?.trim()
    ? parseEnum(values['role'], 'role', [...STAFF_ROLES, ...ROSTER_KINDS])
    : { value: 'rostered', issue: null };
  if (role.issue) issues.push(role.issue);
  normalized['role'] = role.value ?? 'rostered';
  if (values['jersey_number']?.trim())
    normalized['jersey_number'] = values['jersey_number'].trim();
  if (values['positions']?.trim())
    normalized['positions'] = parseList(values['positions']);
  if (values['joined_on']?.trim()) {
    const parsed = parseDate(values['joined_on'], 'joined_on');
    if (parsed.issue) issues.push(parsed.issue);
    if (parsed.value) normalized['joined_on'] = parsed.value;
  }
  return { normalized, issues, duplicates: [] };
}

async function commitRosters(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  let rostered = 0;
  let staffed = 0;
  let peopleCreated = 0;
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const teamSeasonId = str(record, '_team_season_id');
    if (!teamSeasonId) {
      outcomes.set(row.rowId, { targets: [], note: 'unresolved team' });
      continue;
    }
    const targets: RowOutcome['targets'] = [];
    let personId = str(record, '_person_id');
    const create = record['_create_person'] as
      | {
          first_name: string;
          last_name: string;
          email: string | null;
          date_of_birth: string | null;
        }
      | undefined;
    if (!personId && create) {
      personId = newId();
      await trx
        .insertInto('people')
        .values({
          id: personId,
          org_id: ctx.orgId,
          first_name: create.first_name,
          last_name: create.last_name,
          date_of_birth: create.date_of_birth ?? '1900-01-01',
          email: create.email,
        })
        .execute();
      targets.push({ table: 'people', id: personId, version: 1 });
      peopleCreated += 1;
    }
    if (!personId) {
      outcomes.set(row.rowId, { targets: [], note: 'unresolved person' });
      continue;
    }
    const role = str(record, 'role') ?? 'rostered';
    if ((STAFF_ROLES as readonly string[]).includes(role)) {
      const id = newId();
      await trx
        .insertInto('team_staff')
        .values({
          id,
          org_id: ctx.orgId,
          team_season_id: teamSeasonId,
          person_id: personId,
          role,
          status: 'pending_compliance',
          added_by: ctx.actorId,
        })
        .execute();
      targets.push({ table: 'team_staff', id, version: 1 });
      staffed += 1;
    } else {
      const id = newId();
      await trx
        .insertInto('roster_entries')
        .values({
          id,
          org_id: ctx.orgId,
          team_season_id: teamSeasonId,
          person_id: personId,
          kind: role === 'player' ? 'rostered' : role,
          jersey_number: str(record, 'jersey_number'),
          positions: Array.isArray(record['positions'])
            ? (record['positions'] as string[])
            : [],
          joined_on: str(record, 'joined_on') ?? undefined,
        })
        .execute();
      targets.push({ table: 'roster_entries', id, version: 1 });
      rostered += 1;
    }
    outcomes.set(row.rowId, { targets });
  }
  return {
    outcomes,
    summary: { rostered, staff_added: staffed, people_created: peopleCreated },
  };
}

// ---------- schedule ----------

async function normalizeSchedule(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const title = values['title']?.trim();
  const home = values['home_team']?.trim();
  const away = values['away_team']?.trim();
  if (!title && !home && !away)
    issues.push(
      issue('error', 'REQUIRED', 'Provide a title or teams', 'title'),
    );
  if (title) normalized['title'] = title;
  if (home) normalized['home_team'] = home;
  if (away) normalized['away_team'] = away;
  const kind = values['kind']?.trim()
    ? parseEnum(values['kind'], 'kind', [
        'game',
        'practice',
        'meet',
        'match',
        'bout_session',
        'class_session',
        'tournament_game',
        'meeting',
        'volunteer_shift',
        'other',
      ])
    : { value: home || away ? 'game' : 'other', issue: null };
  if (kind.issue) issues.push(kind.issue);
  normalized['kind'] = kind.value ?? 'other';
  const date = values['date']?.trim()
    ? parseDate(values['date'], 'date')
    : {
        value: null,
        issue: issue('error', 'REQUIRED', 'Date is required', 'date'),
      };
  if (date.issue) issues.push(date.issue);
  if (date.value) normalized['date'] = date.value;
  const start = values['start_time']?.trim()
    ? parseTime(values['start_time'], 'start_time')
    : {
        value: null,
        issue: issue(
          'error',
          'REQUIRED',
          'Start time is required',
          'start_time',
        ),
      };
  if (start.issue) issues.push(start.issue);
  if (start.value) normalized['start_time'] = start.value;
  const end = values['end_time']?.trim()
    ? parseTime(values['end_time'], 'end_time')
    : { value: null, issue: null };
  if (end.issue) issues.push(end.issue);
  if (end.value) normalized['end_time'] = end.value;
  if (!end.value && values['duration_minutes']?.trim()) {
    const duration = parseInt_(values['duration_minutes'], 'duration_minutes');
    if (duration.issue) issues.push(duration.issue);
    if (duration.value) normalized['duration_minutes'] = duration.value;
  }
  if (!end.value && !normalized['duration_minutes'])
    normalized['duration_minutes'] = 60;
  const timezone = values['timezone']?.trim();
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      normalized['timezone'] = timezone;
    } catch {
      issues.push(
        issue(
          'error',
          'INVALID_TIMEZONE',
          `"${timezone}" is not an IANA timezone`,
          'timezone',
        ),
      );
    }
  }
  if (values['published']?.trim()) {
    const published = parseBool(values['published'], 'published');
    if (published.issue) issues.push(published.issue);
    if (published.value !== null) normalized['published'] = published.value;
  }
  const programName = values['program']?.trim();
  let programId: string | null = null;
  if (programName) {
    const program = await findProgram(trx, ctx.orgId, programName);
    if (!program)
      issues.push(
        issue(
          'error',
          'PROGRAM_NOT_FOUND',
          `No program named "${programName}"`,
          'program',
        ),
      );
    else {
      programId = program.id;
      normalized['_program_id'] = program.id;
    }
  }
  const facilityName = values['facility']?.trim();
  const spaceName = values['space']?.trim();
  if (facilityName) {
    const facility = await findFacility(trx, ctx.orgId, facilityName);
    if (!facility) {
      normalized['_new_facility'] = facilityName;
      if (spaceName) normalized['_new_space'] = spaceName;
      issues.push(
        issue(
          'warning',
          'FACILITY_WILL_BE_CREATED',
          `Facility "${facilityName}" will be created on commit`,
          'facility',
        ),
      );
    } else if (spaceName) {
      const space = await findSpace(trx, ctx.orgId, facility.id, spaceName);
      if (!space) {
        normalized['_facility_id'] = facility.id;
        normalized['_new_space'] = spaceName;
        issues.push(
          issue(
            'warning',
            'SPACE_WILL_BE_CREATED',
            `Space "${spaceName}" will be created at ${facility.name}`,
            'space',
          ),
        );
      } else normalized['_space_id'] = space.id;
    } else {
      normalized['_facility_id'] = facility.id;
    }
  } else if (spaceName) {
    const space = await findSpace(trx, ctx.orgId, null, spaceName);
    if (!space) {
      normalized['_new_space'] = spaceName;
      normalized['_new_facility'] = spaceName;
      issues.push(
        issue(
          'warning',
          'SPACE_WILL_BE_CREATED',
          `Facility/space "${spaceName}" will be created`,
          'space',
        ),
      );
    } else normalized['_space_id'] = space.id;
  }
  if (values['location_text']?.trim())
    normalized['location_text'] = values['location_text'].trim();
  for (const [key, side] of [
    ['home_team', 'home'],
    ['away_team', 'away'],
  ] as const) {
    const teamName = values[key]?.trim();
    if (!teamName) continue;
    const found = await findTeamSeason(trx, ctx.orgId, teamName, programId);
    if (found) normalized[`_${side}_team_season_id`] = found.teamSeasonId;
    else if (side === 'away') normalized['_external_away'] = teamName;
    else
      issues.push(
        issue(
          'warning',
          'TEAM_NOT_FOUND',
          `No team season "${teamName}"; imported as text`,
          key,
        ),
      );
  }
  return { normalized, issues, duplicates: [] };
}

async function commitSchedule(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  let created = 0;
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const date = str(record, 'date');
    const startTime = str(record, 'start_time');
    if (!date || !startTime) {
      outcomes.set(row.rowId, { targets: [], note: 'missing date/time' });
      continue;
    }
    const orgRow = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', ctx.orgId)
      .executeTakeFirstOrThrow();
    const timezone = str(record, 'timezone') ?? orgRow.timezone;
    const startLocal = `${date}T${startTime}:00`;
    let endLocal: string;
    const endTime = str(record, 'end_time');
    if (endTime) {
      endLocal = `${date}T${endTime}:00`;
    } else {
      const start = new Date(`${startLocal}Z`);
      endLocal = new Date(
        start.getTime() + (num(record, 'duration_minutes') ?? 60) * 60_000,
      )
        .toISOString()
        .slice(0, 19);
    }
    const startsAt = zonedToUtc(startLocal, timezone);
    const endsAt = zonedToUtc(endLocal, timezone);
    const targets: RowOutcome['targets'] = [];
    let spaceId = str(record, '_space_id');
    let facilityId = str(record, '_facility_id');
    if (record['_new_facility'] || record['_new_space']) {
      const facilityName = str(record, '_new_facility');
      const spaceName =
        str(record, '_new_space') ?? str(record, '_new_facility');
      if (!facilityId && facilityName) {
        facilityId = newId();
        await trx
          .insertInto('facilities')
          .values({
            id: facilityId,
            org_id: ctx.orgId,
            name: facilityName,
            ownership: 'owned',
          })
          .execute();
        targets.push({ table: 'facilities', id: facilityId, version: 1 });
      }
      if (spaceName && (facilityId || !spaceId)) {
        const spaceFacilityId = facilityId;
        if (spaceFacilityId) {
          const existing = await findSpace(
            trx,
            ctx.orgId,
            spaceFacilityId,
            spaceName,
          );
          if (existing) {
            spaceId = existing.id;
          } else {
            spaceId = newId();
            await trx
              .insertInto('spaces')
              .values({
                id: spaceId,
                org_id: ctx.orgId,
                facility_id: spaceFacilityId,
                name: spaceName,
                kind: 'other',
              })
              .execute();
            targets.push({ table: 'spaces', id: spaceId, version: 1 });
          }
        }
      }
    }
    let externalAwayId: string | null = null;
    const opponent = str(record, '_external_away');
    if (opponent) {
      const existing = await trx
        .selectFrom('external_teams')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where(sql<boolean>`lower(name) = lower(${opponent})`)
        .executeTakeFirst();
      if (existing) {
        externalAwayId = existing.id;
      } else {
        externalAwayId = newId();
        const profile = await trx
          .selectFrom('sport_profiles')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('archived_at', 'is', null)
          .orderBy('created_at')
          .limit(1)
          .executeTakeFirst();
        if (profile) {
          await trx
            .insertInto('external_teams')
            .values({
              id: externalAwayId,
              org_id: ctx.orgId,
              name: opponent,
              sport_profile_id: profile.id,
            })
            .execute();
          targets.push({
            table: 'external_teams',
            id: externalAwayId,
            version: null,
          });
        } else {
          externalAwayId = null;
        }
      }
    }
    const eventId = newId();
    const home = str(record, 'home_team');
    const away = str(record, 'away_team');
    const title =
      str(record, 'title') ??
      (home && away ? `${home} vs ${away}` : (home ?? away ?? 'Event'));
    await trx
      .insertInto('events')
      .values({
        id: eventId,
        org_id: ctx.orgId,
        program_id: str(record, '_program_id'),
        kind: str(record, 'kind') ?? 'other',
        title,
        starts_at: startsAt,
        ends_at: endsAt,
        timezone,
        space_id: spaceId ?? str(record, '_space_id'),
        location_text: str(record, 'location_text'),
        published: bool(record, 'published') ?? true,
      })
      .execute();
    targets.push({ table: 'events', id: eventId, version: 1 });
    for (const [key, side] of [
      ['_home_team_season_id', 'home'],
      ['_away_team_season_id', 'away'],
    ] as const) {
      const teamSeasonId = str(record, key);
      if (!teamSeasonId) continue;
      const participantId = newId();
      await trx
        .insertInto('event_participants')
        .values({
          id: participantId,
          org_id: ctx.orgId,
          event_id: eventId,
          team_season_id: teamSeasonId,
          side,
        })
        .execute();
      targets.push({
        table: 'event_participants',
        id: participantId,
        version: null,
      });
    }
    if (externalAwayId) {
      const participantId = newId();
      await trx
        .insertInto('event_participants')
        .values({
          id: participantId,
          org_id: ctx.orgId,
          event_id: eventId,
          external_team_id: externalAwayId,
          side: 'away',
        })
        .execute();
      targets.push({
        table: 'event_participants',
        id: participantId,
        version: null,
      });
    }
    created += 1;
    outcomes.set(row.rowId, { targets });
  }
  return { outcomes, summary: { events_created: created } };
}

function zonedToUtc(localIso: string, timezone: string): Date {
  const guess = new Date(`${localIso}Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(guess);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const rendered = `${String(get('year'))}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}T${String(get('hour')).padStart(2, '0')}:${String(get('minute')).padStart(2, '0')}:${String(get('second')).padStart(2, '0')}`;
  const renderedMs = new Date(`${rendered}Z`).getTime();
  const desiredMs = new Date(`${localIso}Z`).getTime();
  return new Date(guess.getTime() + (desiredMs - renderedMs));
}

// ---------- facilities ----------

function normalizeFacility(
  _trx: OrgTransaction,
  _ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const name = requireText(values, 'facility_name', 'Facility name', issues);
  if (name) normalized['facility_name'] = name;
  for (const key of [
    'address_line1',
    'city',
    'state',
    'postal_code',
    'surface',
    'space_name',
  ] as const) {
    const value = values[key]?.trim();
    if (value) normalized[key] = value;
  }
  const timezone = values['timezone']?.trim();
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      normalized['timezone'] = timezone;
    } catch {
      issues.push(
        issue(
          'error',
          'INVALID_TIMEZONE',
          `"${timezone}" is not an IANA timezone`,
          'timezone',
        ),
      );
    }
  }
  const ownership = values['ownership']?.trim()
    ? parseEnum(values['ownership'], 'ownership', [
        'owned',
        'permitted',
        'partner',
      ])
    : { value: null, issue: null };
  if (ownership.issue) issues.push(ownership.issue);
  if (ownership.value) normalized['ownership'] = ownership.value;
  for (const key of ['public', 'has_lights'] as const) {
    const raw = values[key];
    if (!raw?.trim()) continue;
    const { value, issue: found } = parseBool(raw, key);
    if (found) issues.push(found);
    if (value !== null) normalized[key] = value;
  }
  const kind = values['space_kind']?.trim()
    ? parseEnum(values['space_kind'], 'space_kind', [
        'field',
        'court',
        'rink',
        'pool',
        'lanes',
        'mat',
        'diamond',
        'track',
        'room',
        'other',
      ])
    : { value: null, issue: null };
  if (kind.issue) issues.push(kind.issue);
  if (kind.value) normalized['space_kind'] = kind.value;
  const capacity = values['capacity_people']?.trim()
    ? parseInt_(values['capacity_people'], 'capacity_people')
    : { value: null, issue: null };
  if (capacity.issue) issues.push(capacity.issue);
  if (capacity.value) normalized['capacity_people'] = capacity.value;
  return { normalized, issues, duplicates: [] };
}

async function commitFacilities(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  const facilities = new Map<string, string>();
  let created = 0;
  let spaces = 0;
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const name = str(record, 'facility_name') ?? '';
    const targets: RowOutcome['targets'] = [];
    let facilityId = facilities.get(name.toLowerCase()) ?? null;
    if (!facilityId) {
      const existing = await findFacility(trx, ctx.orgId, name);
      if (existing) {
        facilityId = existing.id;
      } else {
        facilityId = newId();
        await trx
          .insertInto('facilities')
          .values({
            id: facilityId,
            org_id: ctx.orgId,
            name,
            address: applyAddress(record),
            timezone: str(record, 'timezone'),
            ownership: str(record, 'ownership') ?? 'owned',
            public: bool(record, 'public') ?? true,
          })
          .execute();
        targets.push({ table: 'facilities', id: facilityId, version: 1 });
        created += 1;
      }
      facilities.set(name.toLowerCase(), facilityId);
    }
    const spaceName = str(record, 'space_name');
    if (spaceName) {
      const existingSpace = await findSpace(
        trx,
        ctx.orgId,
        facilityId,
        spaceName,
      );
      if (!existingSpace) {
        const spaceId = newId();
        await trx
          .insertInto('spaces')
          .values({
            id: spaceId,
            org_id: ctx.orgId,
            facility_id: facilityId,
            name: spaceName,
            kind: str(record, 'space_kind') ?? 'other',
            surface: str(record, 'surface'),
            has_lights: bool(record, 'has_lights') ?? false,
            capacity_people: num(record, 'capacity_people'),
          })
          .execute();
        targets.push({ table: 'spaces', id: spaceId, version: 1 });
        spaces += 1;
      }
    }
    outcomes.set(row.rowId, { targets });
  }
  return {
    outcomes,
    summary: { facilities_created: created, spaces_created: spaces },
  };
}

// ---------- credentials ----------

async function normalizeCredential(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const email = values['person_email']?.trim()
    ? parseEmail(values['person_email'], 'person_email')
    : { value: null, issue: null };
  if (email.issue) issues.push(email.issue);
  const first = values['first_name']?.trim() ?? '';
  const last = values['last_name']?.trim() ?? '';
  if (!email.value && (!first || !last))
    issues.push(
      issue(
        'error',
        'REQUIRED',
        'Provide the person email or first and last name',
        'person_email',
      ),
    );
  const person = await findPerson(trx, ctx.orgId, {
    email: email.value,
    first,
    last,
    dob: null,
  });
  if (person.ambiguous)
    issues.push(
      issue(
        'error',
        'AMBIGUOUS_PERSON',
        'More than one person matches; add an email column',
        'person_email',
      ),
    );
  if (!person.match && !person.ambiguous)
    issues.push(
      issue(
        'error',
        'PERSON_NOT_FOUND',
        'No matching person; import people first',
        'person_email',
      ),
    );
  if (person.match) normalized['_person_id'] = person.match.id;
  const typeName = requireText(
    values,
    'credential_type',
    'Credential type',
    issues,
  );
  if (typeName) {
    normalized['credential_type'] = typeName;
    const type = await trx
      .selectFrom('credential_types')
      .select(['id', 'org_id'])
      .where((eb) =>
        eb.or([eb('org_id', '=', ctx.orgId), eb('org_id', 'is', null)]),
      )
      .where((eb) =>
        eb.or([
          sql<boolean>`lower(name) = lower(${typeName})`,
          sql<boolean>`lower(key) = lower(${typeName.replaceAll(/\s+/g, '_')})`,
        ]),
      )
      .where('active', '=', true)
      .executeTakeFirst();
    if (type) normalized['_credential_type_id'] = type.id;
    else normalized['_create_type'] = true;
  }
  for (const key of ['issued_on', 'expires_on'] as const) {
    const raw = values[key];
    if (!raw?.trim()) continue;
    const { value, issue: found } = parseDate(raw, key);
    if (found) issues.push(found);
    if (value) normalized[key] = value;
  }
  const statusAliases: Record<string, string> = {
    clear: 'verified',
    cleared: 'verified',
    current: 'verified',
    active: 'verified',
    approved: 'verified',
    verified: 'verified',
    pending: 'pending_review',
    pending_review: 'pending_review',
    submitted: 'pending_review',
    expired: 'expired',
  };
  const rawStatus = values['status']?.trim().toLowerCase();
  const status = rawStatus
    ? parseEnum(statusAliases[rawStatus] ?? rawStatus, 'status', [
        'verified',
        'pending_review',
        'expired',
      ])
    : { value: 'verified', issue: null };
  if (status.issue) issues.push(status.issue);
  normalized['status'] = status.value ?? 'verified';
  if (values['identifier']?.trim())
    normalized['identifier'] = values['identifier'].trim();
  const docName = values['document_file']?.trim();
  if (docName) {
    if (!ctx.documents || !ctx.documents.has(docName))
      issues.push(
        issue(
          'error',
          'DOCUMENT_MISSING',
          `"${docName}" is not in the uploaded zip`,
          'document_file',
        ),
      );
    else normalized['document_file'] = docName;
  }
  return { normalized, issues, duplicates: [] };
}

async function commitCredentials(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  let created = 0;
  const typeCache = new Map<string, string>();
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const personId = str(record, '_person_id');
    if (!personId) {
      outcomes.set(row.rowId, { targets: [], note: 'unresolved person' });
      continue;
    }
    let typeId = str(record, '_credential_type_id');
    if (!typeId && record['_create_type']) {
      const typeName = String(record['credential_type']);
      typeId = typeCache.get(typeName.toLowerCase()) ?? null;
      if (!typeId) {
        typeId = newId();
        await trx
          .insertInto('credential_types')
          .values({
            id: typeId,
            org_id: ctx.orgId,
            key: typeName
              .toLowerCase()
              .replaceAll(/[^a-z0-9]+/g, '_')
              .replaceAll(/^_|_$/g, ''),
            name: typeName,
            verification: 'manual_staff',
            validity: { kind: 'months', months: 12 },
            applies_to: { roles: [], minimum_age: null },
          })
          .execute();
        typeCache.set(typeName.toLowerCase(), typeId);
      }
    }
    if (!typeId) {
      outcomes.set(row.rowId, {
        targets: [],
        note: 'unresolved credential type',
      });
      continue;
    }
    const targets: RowOutcome['targets'] = [];
    let fileId: string | null = null;
    const docName = str(record, 'document_file');
    if (docName && ctx.documents?.has(docName) && ctx.createFile) {
      const document = ctx.documents.get(docName);
      if (!document) continue;
      fileId = await ctx.createFile({
        name: docName,
        mime: document.mime,
        bytes: document.bytes,
        ownerType: 'person_credential',
        ownerId: personId,
      });
      if (fileId) targets.push({ table: 'files', id: fileId, version: null });
    }
    const id = newId();
    const status = str(record, 'status') ?? 'verified';
    await trx
      .insertInto('person_credentials')
      .values({
        id,
        org_id: ctx.orgId,
        person_id: personId,
        credential_type_id: typeId,
        status,
        issued_on: str(record, 'issued_on'),
        expires_on: str(record, 'expires_on'),
        file_id: fileId,
        verified_by: status === 'verified' ? ctx.actorId : null,
        verified_at: status === 'verified' ? new Date() : null,
        identifier_hint: str(record, 'identifier')
          ? `••${String(record['identifier']).slice(-4)}`
          : null,
        identifier_enc:
          str(record, 'identifier') && ctx.encryption
            ? encryptRestricted(
                Buffer.from(String(record['identifier']), 'utf8'),
                ctx.encryption,
              )
            : null,
      })
      .execute();
    targets.push({ table: 'person_credentials', id, version: 1 });
    created += 1;
    outcomes.set(row.rowId, { targets });
  }
  return { outcomes, summary: { credentials_created: created } };
}

// ---------- historical payments ----------

async function normalizeHistoricalPayment(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const email = values['payer_email']?.trim()
    ? parseEmail(values['payer_email'], 'payer_email')
    : { value: null, issue: null };
  if (email.issue) issues.push(email.issue);
  if (email.value) normalized['payer_email'] = email.value;
  const first = values['payer_first_name']?.trim() ?? '';
  const last = values['payer_last_name']?.trim() ?? '';
  if (first) normalized['payer_first_name'] = first;
  if (last) normalized['payer_last_name'] = last;
  if (!email.value && (!first || !last))
    issues.push(
      issue(
        'error',
        'REQUIRED',
        'Provide a payer email or first and last name',
        'payer_email',
      ),
    );
  const amount = values['amount']?.trim()
    ? parseMoney(values['amount'], 'amount')
    : {
        value: null,
        issue: issue('error', 'REQUIRED', 'Amount is required', 'amount'),
      };
  if (amount.issue) issues.push(amount.issue);
  if (amount.value !== null) {
    if (amount.value <= 0)
      issues.push(
        issue('error', 'INVALID_MONEY', 'Amount must be positive', 'amount'),
      );
    else normalized['amount_cents'] = amount.value;
  }
  const paidOn = values['paid_on']?.trim()
    ? parseDate(values['paid_on'], 'paid_on')
    : {
        value: null,
        issue: issue(
          'error',
          'REQUIRED',
          'Payment date is required',
          'paid_on',
        ),
      };
  if (paidOn.issue) issues.push(paidOn.issue);
  if (paidOn.value) normalized['paid_on'] = paidOn.value;
  const method = values['method']?.trim()
    ? parseEnum(values['method'], 'method', [
        'cash',
        'check',
        'card',
        'external',
      ])
    : { value: 'external', issue: null };
  if (method.issue) issues.push(method.issue);
  normalized['method'] = method.value ?? 'external';
  for (const key of ['reference', 'description'] as const) {
    const value = values[key]?.trim();
    if (value) normalized[key] = value;
  }
  const programName = values['program']?.trim();
  if (programName) {
    const program = await findProgram(trx, ctx.orgId, programName);
    if (!program)
      issues.push(
        issue(
          'warning',
          'PROGRAM_NOT_FOUND',
          `No program named "${programName}"`,
          'program',
        ),
      );
    else normalized['_program_id'] = program.id;
  }
  if (email.value || first) {
    const person = await findPerson(trx, ctx.orgId, {
      email: email.value,
      first,
      last,
      dob: null,
    });
    if (person.match) normalized['_person_id'] = person.match.id;
    if (person.ambiguous)
      issues.push(
        issue(
          'warning',
          'AMBIGUOUS_PERSON',
          'Multiple people share this identity; payment recorded without a person link',
          'payer_email',
        ),
      );
  }
  return { normalized, issues, duplicates: [] };
}

async function commitHistoricalPayments(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  let created = 0;
  let totalCents = 0;
  const { allocateOrgNumber } = await import('../../db/orgCounters');
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const amountCents = num(record, 'amount_cents');
    if (!amountCents) {
      outcomes.set(row.rowId, { targets: [], note: 'missing amount' });
      continue;
    }
    const targets: RowOutcome['targets'] = [];
    const personId = str(record, '_person_id');
    let accountId: string | null = null;
    let householdId: string | null = null;
    if (personId) {
      accountId = await accountForPerson(trx, ctx.orgId, personId);
      householdId = await primaryHousehold(trx, ctx.orgId, personId);
    }
    if (!accountId) {
      accountId = await importPayerAccount(trx, ctx.orgId);
    }
    const paidOn =
      str(record, 'paid_on') ?? new Date().toISOString().slice(0, 10);
    const paidAt = new Date(`${paidOn}T12:00:00Z`);
    const invoiceId = newId();
    const number = await allocateOrgNumber(trx, ctx.orgId, 'invoice');
    const payerLabel =
      [str(record, 'payer_first_name'), str(record, 'payer_last_name')]
        .filter(Boolean)
        .join(' ') ||
      str(record, 'payer_email') ||
      'Imported payer';
    await trx
      .insertInto('invoices')
      .values({
        id: invoiceId,
        org_id: ctx.orgId,
        number,
        account_id: accountId,
        household_id: householdId,
        status: 'paid',
        issued_at: paidAt,
        due_on: paidAt,
        subtotal_cents: amountCents,
        total_cents: amountCents,
        paid_cents: amountCents,
        memo: `Historical import — ${str(record, 'description') ?? 'payment recorded in a previous system'} (${payerLabel})`,
        source: 'staff',
      })
      .execute();
    targets.push({ table: 'invoices', id: invoiceId, version: 1 });
    const lineId = newId();
    await trx
      .insertInto('invoice_lines')
      .values({
        id: lineId,
        org_id: ctx.orgId,
        invoice_id: invoiceId,
        kind: str(record, '_program_id') ? 'registration' : 'adjustment',
        description:
          str(record, 'description') ?? 'Imported historical payment',
        quantity: 1,
        unit_amount_cents: amountCents,
        amount_cents: amountCents,
        person_id: personId,
        program_id: str(record, '_program_id'),
        refundable: false,
      })
      .execute();
    targets.push({ table: 'invoice_lines', id: lineId, version: null });
    const paymentId = newId();
    await trx
      .insertInto('payments')
      .values({
        id: paymentId,
        org_id: ctx.orgId,
        account_id: accountId,
        method: 'external',
        status: 'succeeded',
        amount_cents: amountCents,
        net_cents: amountCents,
        reference: str(record, 'reference'),
        received_by: ctx.actorId,
        succeeded_at: paidAt,
      })
      .execute();
    targets.push({ table: 'payments', id: paymentId, version: 1 });
    const allocationId = newId();
    await trx
      .insertInto('payment_allocations')
      .values({
        id: allocationId,
        org_id: ctx.orgId,
        payment_id: paymentId,
        invoice_id: invoiceId,
        amount_cents: amountCents,
      })
      .execute();
    targets.push({
      table: 'payment_allocations',
      id: allocationId,
      version: null,
    });
    created += 1;
    totalCents += amountCents;
    outcomes.set(row.rowId, { targets });
  }
  return { outcomes, summary: { created, total_cents: totalCents } };
}

async function importPayerAccount(
  trx: OrgTransaction,
  orgId: string,
): Promise<string> {
  const email = `import-history+${orgId.slice(0, 8)}@athlentry.invalid`;
  const existing = await trx
    .selectFrom('accounts')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) return existing.id;
  const id = newId();
  await trx
    .insertInto('accounts')
    .values({
      id,
      email,
      first_name: 'Imported',
      last_name: 'Payer',
      date_of_birth: '1980-01-01',
      status: 'deactivated',
    })
    .execute();
  return id;
}

// ---------- volunteer hours ----------

async function normalizeVolunteerHours(
  trx: OrgTransaction,
  ctx: CommitContext,
  values: Record<string, string>,
) {
  const issues: ImportIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const email = values['person_email']?.trim()
    ? parseEmail(values['person_email'], 'person_email')
    : { value: null, issue: null };
  if (email.issue) issues.push(email.issue);
  const first = values['first_name']?.trim() ?? '';
  const last = values['last_name']?.trim() ?? '';
  if (!email.value && (!first || !last))
    issues.push(
      issue(
        'error',
        'REQUIRED',
        'Provide the person email or first and last name',
        'person_email',
      ),
    );
  const person = await findPerson(trx, ctx.orgId, {
    email: email.value,
    first,
    last,
    dob: null,
  });
  if (person.ambiguous)
    issues.push(
      issue(
        'error',
        'AMBIGUOUS_PERSON',
        'More than one person matches; add an email column',
        'person_email',
      ),
    );
  if (!person.match && !person.ambiguous)
    issues.push(
      issue(
        'error',
        'PERSON_NOT_FOUND',
        'No matching person; import people first',
        'person_email',
      ),
    );
  if (person.match) normalized['_person_id'] = person.match.id;
  const hours = values['hours']?.trim()
    ? parseMoney(values['hours'], 'hours')
    : {
        value: null,
        issue: issue('error', 'REQUIRED', 'Hours are required', 'hours'),
      };
  if (hours.issue) issues.push(hours.issue);
  if (hours.value !== null) normalized['hours'] = hours.value / 100;
  if (values['role']?.trim()) normalized['role'] = values['role'].trim();
  const occurred = values['occurred_on']?.trim()
    ? parseDate(values['occurred_on'], 'occurred_on')
    : { value: null, issue: null };
  if (occurred.issue) issues.push(occurred.issue);
  if (occurred.value) normalized['occurred_on'] = occurred.value;
  if (values['notes']?.trim()) normalized['notes'] = values['notes'].trim();
  return { normalized, issues, duplicates: [] };
}

async function commitVolunteerHours(
  trx: OrgTransaction,
  ctx: CommitContext,
  rows: {
    rowId: string;
    normalized: Record<string, unknown>;
    action: string;
    targetId: string | null;
  }[],
) {
  const outcomes = new Map<string, RowOutcome>();
  const roles = new Map<string, string>();
  const shifts = new Map<string, string>();
  let credited = 0;
  let hoursTotal = 0;
  for (const row of rows) {
    if (row.action === 'skip') {
      outcomes.set(row.rowId, { targets: [], note: 'skipped' });
      continue;
    }
    const record = row.normalized;
    const personId = str(record, '_person_id');
    const hours = num(record, 'hours');
    if (!personId || !hours) {
      outcomes.set(row.rowId, {
        targets: [],
        note: 'unresolved person or hours',
      });
      continue;
    }
    const targets: RowOutcome['targets'] = [];
    const roleName = str(record, 'role') ?? 'General volunteering';
    let roleId = roles.get(roleName.toLowerCase()) ?? null;
    if (!roleId) {
      const existing = await trx
        .selectFrom('volunteer_roles')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where(sql<boolean>`lower(name) = lower(${roleName})`)
        .executeTakeFirst();
      if (existing) {
        roleId = existing.id;
      } else {
        roleId = newId();
        await trx
          .insertInto('volunteer_roles')
          .values({ id: roleId, org_id: ctx.orgId, name: roleName })
          .execute();
        targets.push({ table: 'volunteer_roles', id: roleId, version: 1 });
      }
      roles.set(roleName.toLowerCase(), roleId);
    }
    const occurredOn = str(record, 'occurred_on') ?? '2020-01-01';
    const shiftKey = `${roleId}|${occurredOn}`;
    let shiftId = shifts.get(shiftKey) ?? null;
    if (!shiftId) {
      shiftId = newId();
      const start = new Date(`${occurredOn}T09:00:00Z`);
      await trx
        .insertInto('volunteer_shifts')
        .values({
          id: shiftId,
          org_id: ctx.orgId,
          volunteer_role_id: roleId,
          title: `Imported hours — ${roleName}`,
          starts_at: start,
          ends_at: new Date(start.getTime() + 3_600_000),
          slots: Math.max(1, rows.length),
          credit_hours: hours,
          imported: true,
        })
        .execute();
      targets.push({ table: 'volunteer_shifts', id: shiftId, version: 1 });
      shifts.set(shiftKey, shiftId);
    }
    const signupId = newId();
    await trx
      .insertInto('volunteer_signups')
      .values({
        id: signupId,
        org_id: ctx.orgId,
        volunteer_shift_id: shiftId,
        person_id: personId,
        household_id: await primaryHousehold(trx, ctx.orgId, personId),
        status: 'completed',
        hours_credited: hours,
        credited_by: ctx.actorId,
      })
      .execute();
    targets.push({ table: 'volunteer_signups', id: signupId, version: 1 });
    credited += 1;
    hoursTotal += hours;
    outcomes.set(row.rowId, { targets });
  }
  return { outcomes, summary: { credited, hours_total: hoursTotal } };
}

// ---------- registry ----------

export const importKinds: Record<ImportKind, KindDefinition> = {
  people: { normalize: normalizePerson, commit: commitPeople },
  households: { normalize: normalizeHousehold, commit: commitHouseholds },
  registrations: {
    normalize: normalizeRegistration,
    commit: commitRegistrations,
  },
  teams: { normalize: normalizeTeam, commit: commitTeams },
  rosters: { normalize: normalizeRoster, commit: commitRosters },
  schedule: { normalize: normalizeSchedule, commit: commitSchedule },
  facilities: { normalize: normalizeFacility, commit: commitFacilities },
  credentials: { normalize: normalizeCredential, commit: commitCredentials },
  historical_payments: {
    normalize: normalizeHistoricalPayment,
    commit: commitHistoricalPayments,
  },
  volunteer_hours: {
    normalize: normalizeVolunteerHours,
    commit: commitVolunteerHours,
  },
};
