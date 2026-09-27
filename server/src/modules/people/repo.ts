import { newId } from '@shared/ids';
import { peopleListSchema, personResponseSchema } from '@shared/schemas/people';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';

export class PeopleError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
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

const selection = [
  'id',
  'org_id',
  'first_name',
  'last_name',
  'preferred_name',
  'date_of_birth',
  'gender',
  'email',
  'phone_e164',
  'media_consent',
  'status',
  'version',
] as const;

function mapPerson(row: {
  id: string;
  org_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: Date;
  gender: string;
  email: string | null;
  phone_e164: string | null;
  media_consent: string;
  status: string;
  version: number;
}): Person {
  return personResponseSchema.parse({
    id: row.id,
    orgId: row.org_id,
    firstName: row.first_name,
    lastName: row.last_name,
    preferredName: row.preferred_name,
    dateOfBirth:
      row.date_of_birth instanceof Date
        ? row.date_of_birth.toISOString().slice(0, 10)
        : row.date_of_birth,
    gender: row.gender,
    email: row.email,
    phoneE164: row.phone_e164,
    mediaConsent: row.media_consent,
    status: row.status,
    version: row.version,
  });
}

async function requireStaff(
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
    async list(
      orgId: string,
      actorId: string,
      query: Query,
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, impersonating);
        let statement = trx
          .selectFrom('people')
          .select(selection)
          .where('org_id', '=', orgId)
          .where('status', '=', query.status);
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
          items: page.map(mapPerson),
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
        const row = await trx
          .selectFrom('people')
          .select(selection)
          .where('org_id', '=', orgId)
          .where('id', '=', personId)
          .executeTakeFirst();
        if (!row) throw new PeopleError(404, 'NOT_FOUND', 'Person not found');
        return mapPerson(row);
      });
    },
    async create(orgId: string, actorId: string, input: Create) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
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
            gender: input.gender,
            email: input.email,
            phone_e164: input.phoneE164,
            media_consent: input.mediaConsent,
          })
          .returning(selection)
          .executeTakeFirstOrThrow();
        await audit(trx, orgId, actorId, id, 'person.created', row.version);
        return mapPerson(row);
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
          ...(input.gender !== undefined ? { gender: input.gender } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phoneE164 !== undefined
            ? { phone_e164: input.phoneE164 }
            : {}),
          ...(input.mediaConsent !== undefined
            ? { media_consent: input.mediaConsent }
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
        await audit(
          trx,
          orgId,
          actorId,
          personId,
          'person.updated',
          row.version,
        );
        return mapPerson(row);
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
        return mapPerson(row);
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
        return mapPerson(row);
      });
    },
  };
}
