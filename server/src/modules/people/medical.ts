import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import { medicalResponseSchema } from '@shared/schemas/medical';
import type { MedicalUpdate } from '@shared/schemas/medical';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';
import { decryptRestricted, encryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';

import { PeopleError } from './repo';

export type PersonCareAccess =
  'full' | 'flags_only' | 'self_read_only' | 'coach_full';

export async function authorizePersonCare(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  personId: string,
  write: boolean,
  medicalDetails = true,
): Promise<PersonCareAccess> {
  let personQuery = trx
    .selectFrom('people')
    .select(['id', 'status', 'date_of_birth'])
    .where('org_id', '=', orgId)
    .where('id', '=', personId);
  if (write) personQuery = personQuery.forUpdate();
  const person = await personQuery.executeTakeFirst();
  if (!person || person.status !== 'active')
    throw new PeopleError(404, 'NOT_FOUND', 'Person not found');

  const link = await trx
    .selectFrom('person_account_links')
    .select('relationship')
    .where('org_id', '=', orgId)
    .where('person_id', '=', personId)
    .where('account_id', '=', actorId)
    .where('verified_at', 'is not', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (link?.relationship === 'guardian') return 'full';
  if (link?.relationship === 'self') {
    const org = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', orgId)
      .executeTakeFirstOrThrow();
    const age = ageOnDate(
      person.date_of_birth.toISOString().slice(0, 10),
      orgToday(org.timezone),
    );
    if (age < 18) {
      if (write)
        throw new PeopleError(404, 'NOT_FOUND', 'Medical profile not found');
      return 'self_read_only';
    }
    return 'full';
  }

  const membership = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', orgId)
    .where('account_id', '=', actorId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (membership) {
    const roles = await trx
      .selectFrom('role_assignments')
      .select('role')
      .where('org_id', '=', orgId)
      .where('account_id', '=', actorId)
      .where('scope_type', '=', 'org')
      .where('pending_mfa', '=', false)
      .where('revoked_at', 'is', null)
      .execute();
    if (
      roles.some((row) => ['owner', 'admin', 'compliance'].includes(row.role))
    )
      return 'full';
    if (roles.some((row) => row.role === 'registrar')) {
      if (!medicalDetails) return 'full';
      const org = await trx
        .selectFrom('organizations')
        .select('settings')
        .where('id', '=', orgId)
        .executeTakeFirst();
      const settings = org?.settings;
      if (
        settings &&
        typeof settings === 'object' &&
        !Array.isArray(settings) &&
        settings.registrarMedicalAccess === true
      )
        return 'full';
    }
  }

  if (!write) {
    const coach = await trx
      .selectFrom('team_staff as staff')
      .innerJoin('roster_entries as roster', (join) =>
        join
          .onRef('roster.org_id', '=', 'staff.org_id')
          .onRef('roster.team_season_id', '=', 'staff.team_season_id'),
      )
      .innerJoin('person_account_links as actor', (join) =>
        join
          .onRef('actor.org_id', '=', 'staff.org_id')
          .onRef('actor.person_id', '=', 'staff.person_id'),
      )
      .select('staff.id')
      .where('staff.org_id', '=', orgId)
      .where('staff.status', '=', 'active')
      .where('roster.person_id', '=', personId)
      .where('roster.status', 'in', ['active', 'injured'])
      .where('actor.account_id', '=', actorId)
      .where('actor.relationship', '=', 'self')
      .where('actor.verified_at', 'is not', null)
      .where('actor.revoked_at', 'is', null)
      .executeTakeFirst();
    if (coach) {
      const org = await trx
        .selectFrom('organizations')
        .select('settings')
        .where('id', '=', orgId)
        .executeTakeFirst();
      const settings = org?.settings;
      const visibility =
        settings && typeof settings === 'object' && !Array.isArray(settings)
          ? settings.coachMedicalAccess
          : undefined;
      return visibility === 'full' ? 'coach_full' : 'flags_only';
    }
  }
  throw new PeopleError(404, 'NOT_FOUND', 'Medical profile not found');
}

function text(
  buffer: Buffer | null,
  encryption: EncryptionKeys,
): string | null {
  return buffer ? decryptRestricted(buffer, encryption).toString('utf8') : null;
}

function encrypted(
  value: string | null,
  encryption: EncryptionKeys,
): Buffer | null {
  return value ? encryptRestricted(Buffer.from(value), encryption) : null;
}

async function audit(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  personId: string,
  action: string,
  visibility: PersonCareAccess,
) {
  await trx
    .insertInto('audit_log')
    .values({
      id: newId(),
      org_id: orgId,
      actor_account_id: actorId,
      action,
      entity_type: 'medical_profile',
      entity_id: personId,
      changes: { visibility, restricted: '[redacted]' },
    })
    .execute();
}

export function createMedicalRepository(
  database: Kysely<DB>,
  encryption: EncryptionKeys,
) {
  const withOrg = createWithOrg(database);
  return {
    async read(orgId: string, actorId: string, personId: string) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        const visibility = await authorizePersonCare(
          trx,
          orgId,
          actorId,
          personId,
          false,
        );
        const row = await trx
          .selectFrom('medical_profiles')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('person_id', '=', personId)
          .executeTakeFirst();
        await audit(trx, orgId, actorId, personId, 'medical.read', visibility);
        const full = visibility !== 'flags_only';
        return medicalResponseSchema.parse({
          personId,
          version: row?.version ?? 0,
          visibility: full ? 'full' : 'flags_only',
          canEdit: visibility === 'full',
          onFile: Boolean(row),
          allergyFlags: row?.allergy_flags ?? [],
          allergies: full && row ? text(row.allergies_enc, encryption) : null,
          conditions: full && row ? text(row.conditions_enc, encryption) : null,
          medications:
            full && row ? text(row.medications_enc, encryption) : null,
          physicianName:
            full && row ? text(row.physician_name_enc, encryption) : null,
          physicianPhone:
            full && row ? text(row.physician_phone_enc, encryption) : null,
          insuranceCarrier:
            full && row ? text(row.insurance_carrier_enc, encryption) : null,
          insurancePolicy:
            full && row ? text(row.insurance_policy_enc, encryption) : null,
          notes: full && row ? text(row.notes_enc, encryption) : null,
        });
      });
    },

    async write(
      orgId: string,
      actorId: string,
      personId: string,
      input: MedicalUpdate,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await authorizePersonCare(trx, orgId, actorId, personId, true);
        const row = await trx
          .selectFrom('medical_profiles')
          .select(['id', 'version'])
          .where('org_id', '=', orgId)
          .where('person_id', '=', personId)
          .forUpdate()
          .executeTakeFirst();
        if ((row?.version ?? 0) !== input.expectedVersion)
          throw new PeopleError(409, 'CONFLICT', 'Medical profile changed');
        const values = {
          allergy_flags: [...new Set(input.allergyFlags)].sort(),
          allergies_enc: encrypted(input.allergies, encryption),
          conditions_enc: encrypted(input.conditions, encryption),
          medications_enc: encrypted(input.medications, encryption),
          physician_name_enc: encrypted(input.physicianName, encryption),
          physician_phone_enc: encrypted(input.physicianPhone, encryption),
          insurance_carrier_enc: encrypted(input.insuranceCarrier, encryption),
          insurance_policy_enc: encrypted(input.insurancePolicy, encryption),
          notes_enc: encrypted(input.notes, encryption),
          updated_by: actorId,
        };
        if (row) {
          await trx
            .updateTable('medical_profiles')
            .set({ ...values, version: sql<number>`version + 1` })
            .where('org_id', '=', orgId)
            .where('id', '=', row.id)
            .execute();
        } else {
          await trx
            .insertInto('medical_profiles')
            .values({
              id: newId(),
              org_id: orgId,
              person_id: personId,
              ...values,
            })
            .execute();
        }
        await audit(trx, orgId, actorId, personId, 'medical.update', 'full');
        return { version: (row?.version ?? 0) + 1 };
      });
    },
  };
}
