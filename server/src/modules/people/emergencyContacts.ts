import { newId } from '@shared/ids';
import {
  emergencyContactSchema,
  emergencyContactsSchema,
} from '@shared/schemas/emergencyContacts';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';

import { authorizePersonCare } from './medical';
import { PeopleError } from './repo';

type Create = z.output<
  typeof import('@shared/schemas/emergencyContacts').emergencyContactCreateSchema
>;
type Update = z.output<
  typeof import('@shared/schemas/emergencyContacts').emergencyContactUpdateSchema
>;

async function audit(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  personId: string,
  contactId: string | null,
  action: string,
) {
  await trx
    .insertInto('audit_log')
    .values({
      id: newId(),
      org_id: orgId,
      actor_account_id: actorId,
      action,
      entity_type: 'emergency_contact',
      entity_id: contactId ?? personId,
      changes: { personId, details: '[redacted]' },
    })
    .execute();
}

function present(row: {
  id: string;
  name: string;
  relationship: string;
  phone_e164: string;
  alt_phone_e164: string | null;
  priority: number;
  version: number;
}) {
  return emergencyContactSchema.parse({
    id: row.id,
    name: row.name,
    relationship: row.relationship,
    phoneE164: row.phone_e164,
    altPhoneE164: row.alt_phone_e164,
    priority: row.priority,
    version: row.version,
  });
}

function conflict(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505'
  )
    throw new PeopleError(
      409,
      'CONFLICT',
      'Emergency contact priority is already in use',
    );
  throw error;
}

export function createEmergencyContactsRepository(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);
  return {
    async list(orgId: string, actorId: string, personId: string) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        const access = await authorizePersonCare(
          trx,
          orgId,
          actorId,
          personId,
          false,
          false,
        );
        const rows = await trx
          .selectFrom('emergency_contacts')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('person_id', '=', personId)
          .where('removed_at', 'is', null)
          .orderBy('priority')
          .orderBy('id')
          .execute();
        await audit(
          trx,
          orgId,
          actorId,
          personId,
          null,
          'emergency_contact.read',
        );
        return emergencyContactsSchema.parse({
          items: rows.map(present),
          canEdit: access === 'full',
        });
      });
    },

    async create(
      orgId: string,
      actorId: string,
      personId: string,
      input: Create,
    ) {
      try {
        return await withOrg(
          { orgId, actor: { accountId: actorId } },
          async (trx) => {
            await authorizePersonCare(
              trx,
              orgId,
              actorId,
              personId,
              true,
              false,
            );
            const id = newId();
            await trx
              .insertInto('emergency_contacts')
              .values({
                id,
                org_id: orgId,
                person_id: personId,
                name: input.name,
                relationship: input.relationship,
                phone_e164: input.phoneE164,
                alt_phone_e164: input.altPhoneE164,
                priority: input.priority,
              })
              .execute();
            await audit(
              trx,
              orgId,
              actorId,
              personId,
              id,
              'emergency_contact.create',
            );
            return { id };
          },
        );
      } catch (error) {
        conflict(error);
      }
    },

    async update(
      orgId: string,
      actorId: string,
      personId: string,
      contactId: string,
      input: Update,
    ) {
      try {
        return await withOrg(
          { orgId, actor: { accountId: actorId } },
          async (trx) => {
            await authorizePersonCare(
              trx,
              orgId,
              actorId,
              personId,
              true,
              false,
            );
            const row = await trx
              .selectFrom('emergency_contacts')
              .select('version')
              .where('org_id', '=', orgId)
              .where('person_id', '=', personId)
              .where('id', '=', contactId)
              .where('removed_at', 'is', null)
              .forUpdate()
              .executeTakeFirst();
            if (!row)
              throw new PeopleError(
                404,
                'NOT_FOUND',
                'Emergency contact not found',
              );
            if (row.version !== input.expectedVersion)
              throw new PeopleError(
                409,
                'CONFLICT',
                'Emergency contact changed',
              );
            await trx
              .updateTable('emergency_contacts')
              .set({
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.relationship === undefined
                  ? {}
                  : { relationship: input.relationship }),
                ...(input.phoneE164 === undefined
                  ? {}
                  : { phone_e164: input.phoneE164 }),
                ...(input.altPhoneE164 === undefined
                  ? {}
                  : { alt_phone_e164: input.altPhoneE164 }),
                ...(input.priority === undefined
                  ? {}
                  : { priority: input.priority }),
                version: sql<number>`version + 1`,
              })
              .where('org_id', '=', orgId)
              .where('id', '=', contactId)
              .execute();
            await audit(
              trx,
              orgId,
              actorId,
              personId,
              contactId,
              'emergency_contact.update',
            );
            return { id: contactId };
          },
        );
      } catch (error) {
        conflict(error);
      }
    },

    async remove(
      orgId: string,
      actorId: string,
      personId: string,
      contactId: string,
      expectedVersion: number,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await authorizePersonCare(trx, orgId, actorId, personId, true, false);
        const row = await trx
          .selectFrom('emergency_contacts')
          .select('version')
          .where('org_id', '=', orgId)
          .where('person_id', '=', personId)
          .where('id', '=', contactId)
          .where('removed_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!row)
          throw new PeopleError(
            404,
            'NOT_FOUND',
            'Emergency contact not found',
          );
        if (row.version !== expectedVersion)
          throw new PeopleError(409, 'CONFLICT', 'Emergency contact changed');
        const activeRegistration = await trx
          .selectFrom('registrations')
          .select('id')
          .where('org_id', '=', orgId)
          .where('person_id', '=', personId)
          .where('status', 'not in', [
            'canceled',
            'withdrawn',
            'transferred_out',
          ])
          .executeTakeFirst();
        if (activeRegistration) {
          const other = await trx
            .selectFrom('emergency_contacts')
            .select('id')
            .where('org_id', '=', orgId)
            .where('person_id', '=', personId)
            .where('removed_at', 'is', null)
            .where('id', '!=', contactId)
            .executeTakeFirst();
          if (!other)
            throw new PeopleError(
              409,
              'CONFLICT',
              'An active registration requires an emergency contact',
            );
        }
        await trx
          .updateTable('emergency_contacts')
          .set({
            removed_at: new Date(),
            version: sql<number>`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('id', '=', contactId)
          .execute();
        await audit(
          trx,
          orgId,
          actorId,
          personId,
          contactId,
          'emergency_contact.remove',
        );
        return { id: contactId };
      });
    },
  };
}
