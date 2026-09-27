import { Temporal } from '@js-temporal/polyfill';
import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import { peopleListSchema, personResponseSchema } from '@shared/schemas/people';
import {
  gradeFromGraduationYear,
  gradeLabel,
  schoolYearEndYear,
} from '@shared/sport/age';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';

export class PeopleError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: 'VALIDATION_ERROR' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

type Person = z.output<typeof personResponseSchema>;
type Create = z.output<
  typeof import('@shared/schemas/people').personCreateSchema
>;
type Update = z.output<
  typeof import('@shared/schemas/people').personUpdateSchema
>;
type Query = z.output<
  typeof import('@shared/schemas/people').peopleQuerySchema
>;
type FilterOptionsQuery = z.output<
  typeof import('@shared/schemas/people').peopleFilterOptionsQuerySchema
>;

const selection = [
  'id',
  'org_id',
  'first_name',
  'last_name',
  'preferred_name',
  'date_of_birth',
  'graduation_year',
  'gender',
  'email',
  'phone_e164',
  'media_consent',
  'photo_file_id',
  'status',
  'version',
] as const;

type Presentation = { today: string; schoolYearEnd: number };

async function presentation(
  trx: OrgTransaction,
  orgId: string,
): Promise<Presentation> {
  const org = await trx
    .selectFrom('organizations')
    .select(['timezone', 'settings'])
    .where('id', '=', orgId)
    .executeTakeFirst();
  if (!org) throw new PeopleError(404, 'NOT_FOUND', 'Organization not found');
  const today = orgToday(org.timezone);
  const settings = org.settings;
  const configured =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings.peopleSchoolYearCutoff
      : undefined;
  const cutoff = configured === undefined ? '08-01' : configured;
  if (typeof cutoff !== 'string')
    throw new Error('Invalid organization school-year cutoff');
  return { today, schoolYearEnd: schoolYearEndYear(today, cutoff) };
}

function validateBirthDate(dateOfBirth: string, context: Presentation): void {
  if (dateOfBirth > context.today)
    throw new PeopleError(
      400,
      'VALIDATION_ERROR',
      'Date of birth cannot be in the future',
    );
}

function mapPerson(
  row: {
    id: string;
    org_id: string;
    first_name: string;
    last_name: string;
    preferred_name: string | null;
    date_of_birth: Date;
    graduation_year: number | null;
    gender: string;
    email: string | null;
    phone_e164: string | null;
    media_consent: string;
    photo_file_id: string | null;
    status: string;
    version: number;
  },
  context: Presentation,
): Person {
  const birth =
    row.date_of_birth instanceof Date
      ? row.date_of_birth.toISOString().slice(0, 10)
      : row.date_of_birth;
  return personResponseSchema.parse({
    id: row.id,
    orgId: row.org_id,
    firstName: row.first_name,
    lastName: row.last_name,
    preferredName: row.preferred_name,
    dateOfBirth: birth,
    graduationYear: row.graduation_year,
    age: ageOnDate(birth, context.today),
    grade:
      row.graduation_year === null
        ? null
        : gradeLabel(
            gradeFromGraduationYear(row.graduation_year, context.schoolYearEnd),
          ),
    gender: row.gender,
    email: row.email,
    phoneE164: row.phone_e164,
    mediaConsent: row.media_consent,
    photoFileId: row.media_consent === 'granted' ? row.photo_file_id : null,
    status: row.status,
    version: row.version,
  });
}

export async function requireStaff(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  impersonating: boolean,
): Promise<void> {
  if (impersonating) return;
  const staff = await trx
    .selectFrom('org_memberships')
    .innerJoin('role_assignments', (join) =>
      join
        .onRef('role_assignments.org_id', '=', 'org_memberships.org_id')
        .onRef(
          'role_assignments.account_id',
          '=',
          'org_memberships.account_id',
        ),
    )
    .select('org_memberships.id')
    .where('org_memberships.org_id', '=', orgId)
    .where('org_memberships.account_id', '=', actorId)
    .where('org_memberships.status', '=', 'active')
    .where('role_assignments.role', 'in', ['owner', 'admin', 'registrar'])
    .where('role_assignments.scope_type', '=', 'org')
    .where('role_assignments.pending_mfa', '=', false)
    .where('role_assignments.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!staff) throw new PeopleError(404, 'NOT_FOUND', 'Organization not found');
}

async function audit(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  personId: string,
  action: string,
  version: number,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: newId(),
      org_id: orgId,
      actor_account_id: actorId,
      action,
      entity_type: 'person',
      entity_id: personId,
      changes: { version },
    })
    .execute();
}

export function createPeopleRepository(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);
  return {
    async filterOptions(
      orgId: string,
      actorId: string,
      query: FilterOptionsQuery,
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, impersonating);
        const term = query.q
          ? `%${query.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
          : null;
        if (query.kind === 'program') {
          let statement = trx
            .selectFrom('programs')
            .select(['id', 'name'])
            .where('org_id', '=', orgId);
          if (term) statement = statement.where('name', 'ilike', term);
          return {
            items: await statement
              .orderBy('name')
              .orderBy('id')
              .limit(30)
              .execute(),
          };
        }
        let statement = trx
          .selectFrom('team_seasons as season')
          .innerJoin('teams as team', (join) =>
            join
              .onRef('team.org_id', '=', 'season.org_id')
              .onRef('team.id', '=', 'season.team_id'),
          )
          .innerJoin('programs as program', (join) =>
            join
              .onRef('program.org_id', '=', 'season.org_id')
              .onRef('program.id', '=', 'season.program_id'),
          )
          .select([
            'season.id',
            sql<string>`coalesce(season.display_name, team.name) || ' — ' || program.name`.as(
              'name',
            ),
          ])
          .where('season.org_id', '=', orgId);
        if (term)
          statement = statement.where((eb) =>
            eb.or([
              eb('team.name', 'ilike', term),
              eb('season.display_name', 'ilike', term),
              eb('program.name', 'ilike', term),
            ]),
          );
        return {
          items: await statement
            .orderBy('name')
            .orderBy('season.id')
            .limit(30)
            .execute(),
        };
      });
    },
    async list(
      orgId: string,
      actorId: string,
      query: Query,
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, impersonating);
        const context = await presentation(trx, orgId);
        if (
          query.minAge !== undefined &&
          query.maxAge !== undefined &&
          query.minAge > query.maxAge
        )
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'Minimum age exceeds maximum age',
          );
        let statement = trx
          .selectFrom('people')
          .select(selection)
          .where('org_id', '=', orgId)
          .where('status', '=', query.status);
        if (query.gender)
          statement = statement.where('gender', '=', query.gender);
        if (query.householdId)
          statement = statement.where(sql<boolean>`EXISTS (
            SELECT 1 FROM household_members hm
            WHERE hm.org_id = people.org_id AND hm.person_id = people.id
              AND hm.household_id = ${query.householdId}::uuid
              AND hm.removed_at IS NULL
          )`);
        if (query.programId)
          statement = statement.where(sql<boolean>`EXISTS (
            SELECT 1 FROM registrations registration
            WHERE registration.org_id = people.org_id AND registration.person_id = people.id
              AND registration.program_id = ${query.programId}::uuid
              AND registration.status NOT IN ('canceled', 'withdrawn', 'transferred_out')
          )`);
        if (query.teamSeasonId)
          statement = statement.where(sql<boolean>`EXISTS (
            SELECT 1 FROM roster_entries roster
            WHERE roster.org_id = people.org_id AND roster.person_id = people.id
              AND roster.team_season_id = ${query.teamSeasonId}::uuid
              AND roster.status IN ('active', 'injured', 'suspended')
              AND roster.left_on IS NULL
          )`);
        if (query.credentialStatus) {
          const matchingCredentials =
            query.credentialStatus === 'none'
              ? sql<boolean>`EXISTS (
              SELECT 1 FROM person_credentials credential
              WHERE credential.org_id = people.org_id AND credential.person_id = people.id
            )`
              : sql<boolean>`EXISTS (
              SELECT 1 FROM person_credentials credential
              WHERE credential.org_id = people.org_id AND credential.person_id = people.id
                AND credential.status = ${query.credentialStatus}
            )`;
          statement = statement.where(
            query.credentialStatus === 'none'
              ? sql<boolean>`NOT ${matchingCredentials}`
              : matchingCredentials,
          );
        }
        if (query.hasBalance !== undefined) {
          const outstanding = sql<boolean>`EXISTS (
            SELECT 1 FROM invoice_lines il
            JOIN invoices invoice ON invoice.org_id = il.org_id AND invoice.id = il.invoice_id
            WHERE il.org_id = people.org_id AND il.person_id = people.id
              AND invoice.status NOT IN ('void', 'draft')
              AND invoice.balance_cents > 0
          )`;
          statement = statement.where(
            query.hasBalance ? outstanding : sql<boolean>`NOT ${outstanding}`,
          );
        }
        if (query.grade !== undefined)
          statement = statement.where(
            'graduation_year',
            '=',
            context.schoolYearEnd + 12 - query.grade,
          );
        if (query.minAge !== undefined) {
          const latestBirth = Temporal.PlainDate.from(context.today)
            .subtract({ years: query.minAge })
            .toString();
          statement = statement.where(
            'date_of_birth',
            '<=',
            new Date(`${latestBirth}T00:00:00Z`),
          );
        }
        if (query.maxAge !== undefined) {
          const earliestBirth = Temporal.PlainDate.from(context.today)
            .subtract({ years: query.maxAge + 1 })
            .toString();
          statement = statement.where(
            'date_of_birth',
            '>',
            new Date(`${earliestBirth}T00:00:00Z`),
          );
        }
        if (query.cursor) statement = statement.where('id', '>', query.cursor);
        if (query.q) {
          const term = `%${query.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
          statement = statement.where((eb) =>
            eb.or([
              eb('first_name', 'ilike', term),
              eb('last_name', 'ilike', term),
              eb('preferred_name', 'ilike', term),
              sql<boolean>`(first_name || ' ' || last_name) ILIKE ${term}`,
            ]),
          );
        }
        const rows = await statement
          .orderBy('id')
          .limit(query.limit + 1)
          .execute();
        const page = rows.slice(0, query.limit);
        return peopleListSchema.parse({
          items: page.map((row) => mapPerson(row, context)),
          nextCursor: rows.length > query.limit ? page.at(-1)?.id : null,
        });
      });
    },
    async get(
      orgId: string,
      actorId: string,
      personId: string,
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, impersonating);
        const context = await presentation(trx, orgId);
        const row = await trx
          .selectFrom('people')
          .select(selection)
          .where('org_id', '=', orgId)
          .where('id', '=', personId)
          .executeTakeFirst();
        if (!row) throw new PeopleError(404, 'NOT_FOUND', 'Person not found');
        return mapPerson(row, context);
      });
    },
    async create(orgId: string, actorId: string, input: Create) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const context = await presentation(trx, orgId);
        validateBirthDate(input.dateOfBirth, context);
        const id = newId();
        const row = await trx
          .insertInto('people')
          .values({
            id,
            org_id: orgId,
            first_name: input.firstName,
            last_name: input.lastName,
            preferred_name: input.preferredName,
            date_of_birth: input.dateOfBirth,
            graduation_year: input.graduationYear,
            gender: input.gender,
            email: input.email,
            phone_e164: input.phoneE164,
            media_consent: input.mediaConsent,
          })
          .returning(selection)
          .executeTakeFirstOrThrow();
        await audit(trx, orgId, actorId, id, 'person.created', row.version);
        return mapPerson(row, context);
      });
    },
    async update(
      orgId: string,
      actorId: string,
      personId: string,
      input: Update,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const context = await presentation(trx, orgId);
        if (input.dateOfBirth !== undefined)
          validateBirthDate(input.dateOfBirth, context);
        const priorPhoto =
          input.mediaConsent && input.mediaConsent !== 'granted'
            ? await trx
                .selectFrom('people')
                .select('photo_file_id')
                .where('org_id', '=', orgId)
                .where('id', '=', personId)
                .where('version', '=', input.expectedVersion)
                .forUpdate()
                .executeTakeFirst()
            : null;
        const fields = {
          ...(input.firstName !== undefined
            ? { first_name: input.firstName }
            : {}),
          ...(input.lastName !== undefined
            ? { last_name: input.lastName }
            : {}),
          ...(input.preferredName !== undefined
            ? { preferred_name: input.preferredName }
            : {}),
          ...(input.dateOfBirth !== undefined
            ? { date_of_birth: input.dateOfBirth }
            : {}),
          ...(input.graduationYear !== undefined
            ? { graduation_year: input.graduationYear }
            : {}),
          ...(input.gender !== undefined ? { gender: input.gender } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phoneE164 !== undefined
            ? { phone_e164: input.phoneE164 }
            : {}),
          ...(input.mediaConsent !== undefined
            ? {
                media_consent: input.mediaConsent,
                ...(input.mediaConsent !== 'granted'
                  ? { photo_file_id: null }
                  : {}),
              }
            : {}),
        };
        const row = await trx
          .updateTable('people')
          .set({ ...fields, version: sql`version + 1` })
          .where('org_id', '=', orgId)
          .where('id', '=', personId)
          .where('version', '=', input.expectedVersion)
          .where('status', '=', 'active')
          .returning(selection)
          .executeTakeFirst();
        if (!row)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Person changed; reload before saving',
          );
        if (priorPhoto?.photo_file_id)
          await trx
            .updateTable('files')
            .set({ deleted_at: new Date() })
            .where('org_id', '=', orgId)
            .where('id', '=', priorPhoto.photo_file_id)
            .where('deleted_at', 'is', null)
            .execute();
        await audit(
          trx,
          orgId,
          actorId,
          personId,
          'person.updated',
          row.version,
        );
        return mapPerson(row, context);
      });
    },
    async setPhoto(
      orgId: string,
      actorId: string,
      personId: string,
      input: { expectedVersion: number; fileId: string | null },
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const current = await trx
          .selectFrom('people')
          .select(['version', 'status', 'media_consent', 'photo_file_id'])
          .where('org_id', '=', orgId)
          .where('id', '=', personId)
          .forUpdate()
          .executeTakeFirst();
        if (!current)
          throw new PeopleError(404, 'NOT_FOUND', 'Person not found');
        if (
          current.status !== 'active' ||
          current.version !== input.expectedVersion
        )
          throw new PeopleError(
            409,
            'CONFLICT',
            'Person changed; reload before saving',
          );
        if (input.fileId) {
          if (current.media_consent !== 'granted')
            throw new PeopleError(409, 'CONFLICT', 'Photo consent is required');
          const file = await trx
            .selectFrom('files')
            .select('id')
            .where('org_id', '=', orgId)
            .where('id', '=', input.fileId)
            .where('owner_type', '=', 'person')
            .where('owner_id', '=', personId)
            .where('purpose', '=', 'image')
            .where('sensitivity', '=', 'sensitive')
            .where('upload_state', '=', 'complete')
            .where('deleted_at', 'is', null)
            .where('mime', 'in', ['image/jpeg', 'image/png', 'image/webp'])
            .executeTakeFirst();
          if (!file)
            throw new PeopleError(
              400,
              'VALIDATION_ERROR',
              'Photo file is unavailable',
            );
        }
        const row = await trx
          .updateTable('people')
          .set({ photo_file_id: input.fileId, version: sql`version + 1` })
          .where('org_id', '=', orgId)
          .where('id', '=', personId)
          .where('version', '=', input.expectedVersion)
          .returning(selection)
          .executeTakeFirstOrThrow();
        if (current.photo_file_id && current.photo_file_id !== input.fileId)
          await trx
            .updateTable('files')
            .set({ deleted_at: new Date() })
            .where('org_id', '=', orgId)
            .where('id', '=', current.photo_file_id)
            .where('deleted_at', 'is', null)
            .execute();
        await audit(
          trx,
          orgId,
          actorId,
          personId,
          input.fileId ? 'person.photo_attached' : 'person.photo_removed',
          row.version,
        );
        return mapPerson(row, await presentation(trx, orgId));
      });
    },
    async archive(
      orgId: string,
      actorId: string,
      personId: string,
      expectedVersion: number,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const context = await presentation(trx, orgId);
        const row = await trx
          .updateTable('people')
          .set({ status: 'archived', version: sql`version + 1` })
          .where('org_id', '=', orgId)
          .where('id', '=', personId)
          .where('version', '=', expectedVersion)
          .where('status', '=', 'active')
          .returning(selection)
          .executeTakeFirst();
        if (!row)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Person changed; reload before archiving',
          );
        await audit(
          trx,
          orgId,
          actorId,
          personId,
          'person.archived',
          row.version,
        );
        return mapPerson(row, context);
      });
    },
    async restore(
      orgId: string,
      actorId: string,
      personId: string,
      expectedVersion: number,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const context = await presentation(trx, orgId);
        const row = await trx
          .updateTable('people')
          .set({ status: 'active', version: sql`version + 1` })
          .where('org_id', '=', orgId)
          .where('id', '=', personId)
          .where('version', '=', expectedVersion)
          .where('status', '=', 'archived')
          .returning(selection)
          .executeTakeFirst();
        if (!row)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Person changed; reload before restoring',
          );
        await audit(
          trx,
          orgId,
          actorId,
          personId,
          'person.restored',
          row.version,
        );
        return mapPerson(row, context);
      });
    },
  };
}
