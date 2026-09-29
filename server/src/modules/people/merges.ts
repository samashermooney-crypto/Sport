import { newId } from '@shared/ids';
import {
  duplicatesResponseSchema,
  personMergeResponseSchema,
} from '@shared/schemas/people';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';

import { PeopleError, requireStaff } from './repo';

const terminalRegistrationStatuses = [
  'canceled',
  'withdrawn',
  'transferred_out',
] as const;

interface DuplicateRow {
  a_id: string;
  a_first: string;
  a_last: string;
  a_dob: Date;
  a_email: string | null;
  a_phone: string | null;
  b_id: string;
  b_first: string;
  b_last: string;
  b_dob: Date;
  b_email: string | null;
  b_phone: string | null;
  reason: 'same_email' | 'same_phone' | 'similar_name_birth_date';
}

const personIdTables = [
  'athlete_cards',
  'background_check_orders',
  'compliance_overrides',
  'contest_participants',
  'discipline_records',
  'event_participants',
  'injury_reports',
  'invoice_lines',
  'message_deliveries',
  'official_assignments',
  'official_availability',
  'official_pay_lines',
  'official_profiles',
  'person_credentials',
  'playing_time',
  'pool_members',
  'registrations',
  'roster_entries',
  'stat_lines',
  'team_staff',
  'waitlist_entries',
] as const;

async function moveColumn(
  trx: OrgTransaction,
  table: (typeof personIdTables)[number],
  orgId: string,
  mergedId: string,
  survivorId: string,
): Promise<number> {
  const result = await trx
    .updateTable(table)
    .set({ person_id: survivorId })
    .where('org_id', '=', orgId)
    .where('person_id', '=', mergedId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export function createMergesRepository(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);
  return {
    async duplicates(orgId: string, actorId: string) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const rows = await sql<DuplicateRow>`
          SELECT
            a.id AS a_id, a.first_name AS a_first, a.last_name AS a_last,
            a.date_of_birth AS a_dob, a.email AS a_email, a.phone_e164 AS a_phone,
            b.id AS b_id, b.first_name AS b_first, b.last_name AS b_last,
            b.date_of_birth AS b_dob, b.email AS b_email, b.phone_e164 AS b_phone,
            CASE
              WHEN a.email IS NOT NULL AND a.email = b.email THEN 'same_email'
              WHEN a.phone_e164 IS NOT NULL AND a.phone_e164 = b.phone_e164 THEN 'same_phone'
              ELSE 'similar_name_birth_date'
            END AS reason
          FROM people a
          JOIN people b ON b.org_id = a.org_id AND b.id > a.id
          WHERE a.org_id = ${orgId}
            AND a.status = 'active' AND b.status = 'active'
            AND (
              (a.date_of_birth = b.date_of_birth
                AND similarity(a.first_name || ' ' || a.last_name, b.first_name || ' ' || b.last_name) >= 0.35)
              OR (a.email IS NOT NULL AND a.email = b.email)
              OR (a.phone_e164 IS NOT NULL AND a.phone_e164 = b.phone_e164)
            )
          ORDER BY a.last_name, a.first_name
          LIMIT 200
        `.execute(trx);
        return duplicatesResponseSchema.parse({
          items: rows.rows.map((row) => ({
            a: {
              id: row.a_id,
              firstName: row.a_first,
              lastName: row.a_last,
              dateOfBirth: row.a_dob.toISOString().slice(0, 10),
              email: row.a_email,
              phoneE164: row.a_phone,
            },
            b: {
              id: row.b_id,
              firstName: row.b_first,
              lastName: row.b_last,
              dateOfBirth: row.b_dob.toISOString().slice(0, 10),
              email: row.b_email,
              phoneE164: row.b_phone,
            },
            reason: row.reason,
          })),
        });
      });
    },

    async merge(
      orgId: string,
      actorId: string,
      survivorId: string,
      mergedId: string,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        if (survivorId === mergedId)
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'Survivor and merged person differ',
          );
        const people = await trx
          .selectFrom('people')
          .select(['id', 'status', 'version', 'first_name', 'last_name'])
          .where('org_id', '=', orgId)
          .where('id', 'in', [survivorId, mergedId])
          .forUpdate()
          .execute();
        const survivor = people.find((row) => row.id === survivorId);
        const merged = people.find((row) => row.id === mergedId);
        if (
          !survivor ||
          !merged ||
          survivor.status !== 'active' ||
          merged.status !== 'active'
        )
          throw new PeopleError(404, 'NOT_FOUND', 'Active person not found');

        const conflicts = await trx
          .selectFrom('registrations as keep')
          .innerJoin('registrations as drop', (join) =>
            join
              .onRef('drop.org_id', '=', 'keep.org_id')
              .onRef('drop.program_id', '=', 'keep.program_id'),
          )
          .innerJoin('programs as program', (join) =>
            join
              .onRef('program.org_id', '=', 'keep.org_id')
              .onRef('program.id', '=', 'keep.program_id'),
          )
          .select(['program.id as program_id', 'program.name as program_name'])
          .where('keep.org_id', '=', orgId)
          .where('keep.person_id', '=', survivorId)
          .where('keep.status', 'not in', [...terminalRegistrationStatuses])
          .where('drop.org_id', '=', orgId)
          .where('drop.person_id', '=', mergedId)
          .where('drop.status', 'not in', [...terminalRegistrationStatuses])
          .execute();
        if (conflicts.length > 0)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Both people hold active registrations in the same program',
            {
              conflicts: conflicts.map((row) => ({
                programId: row.program_id,
                programName: row.program_name,
              })),
            },
          );

        const moved: Record<string, number> = {};
        for (const table of personIdTables) {
          const count = await moveColumn(
            trx,
            table,
            orgId,
            mergedId,
            survivorId,
          );
          if (count > 0) moved[table] = count;
        }

        const responses = await trx
          .updateTable('form_responses')
          .set({ subject_id: survivorId })
          .where('org_id', '=', orgId)
          .where('subject_type', '=', 'person')
          .where('subject_id', '=', mergedId)
          .executeTakeFirst();
        if (Number(responses.numUpdatedRows) > 0)
          moved.form_responses = Number(responses.numUpdatedRows);

        // Preserve signed waiver evidence exactly as recorded. Waiver reads
        // resolve these original person ids through person_merges lineage.

        const pickedUp = await trx
          .updateTable('attendance')
          .set({ picked_up_by_person_id: survivorId })
          .where('org_id', '=', orgId)
          .where('picked_up_by_person_id', '=', mergedId)
          .executeTakeFirst();
        const attendanceMoved = await trx
          .updateTable('attendance')
          .set({ person_id: survivorId })
          .where('org_id', '=', orgId)
          .where('person_id', '=', mergedId)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('attendance as twin')
                  .select('twin.id')
                  .whereRef('twin.org_id', '=', 'attendance.org_id')
                  .whereRef('twin.event_id', '=', 'attendance.event_id')
                  .where('twin.person_id', '=', survivorId),
              ),
            ),
          )
          .executeTakeFirst();
        moved.attendance = Number(attendanceMoved.numUpdatedRows);
        moved.attendance_same_event_kept = await trx
          .selectFrom('attendance')
          .select(({ fn }) => fn.countAll().as('n'))
          .where('org_id', '=', orgId)
          .where('person_id', '=', mergedId)
          .executeTakeFirst()
          .then((row) => Number(row?.n ?? 0));
        if (Number(pickedUp.numUpdatedRows) > 0)
          moved['attendance.picked_up_by_person_id'] = Number(
            pickedUp.numUpdatedRows,
          );

        const duplicateMemberships = await trx
          .deleteFrom('household_members as old_member')
          .where('old_member.org_id', '=', orgId)
          .where('old_member.person_id', '=', mergedId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('household_members as twin')
                .select('twin.id')
                .whereRef('twin.org_id', '=', 'old_member.org_id')
                .whereRef('twin.household_id', '=', 'old_member.household_id')
                .where('twin.person_id', '=', survivorId),
            ),
          )
          .executeTakeFirst();
        const memberships = await trx
          .updateTable('household_members')
          .set({ person_id: survivorId })
          .where('org_id', '=', orgId)
          .where('person_id', '=', mergedId)
          .executeTakeFirst();
        moved.household_members = Number(memberships.numUpdatedRows);
        if (Number(duplicateMemberships.numDeletedRows) > 0)
          moved.household_members_deduplicated = Number(
            duplicateMemberships.numDeletedRows,
          );

        const maxPriority = await trx
          .selectFrom('emergency_contacts')
          .select(({ fn }) => fn.max('priority').as('max_priority'))
          .where('org_id', '=', orgId)
          .where('person_id', '=', survivorId)
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        const contacts = await sql<{ id: string }>`
          UPDATE emergency_contacts
          SET person_id = ${survivorId},
            priority = priority + ${maxPriority?.max_priority ?? 0}
          WHERE org_id = ${orgId} AND person_id = ${mergedId}
          RETURNING id
        `.execute(trx);
        if (contacts.rows.length > 0)
          moved.emergency_contacts = contacts.rows.length;

        const duplicateLinks = await trx
          .updateTable('person_account_links as old_link')
          .set({ revoked_at: new Date() })
          .where('old_link.org_id', '=', orgId)
          .where('old_link.person_id', '=', mergedId)
          .where('old_link.revoked_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb.exists(
                eb
                  .selectFrom('person_account_links as twin')
                  .select('twin.id')
                  .whereRef('twin.org_id', '=', 'old_link.org_id')
                  .whereRef('twin.account_id', '=', 'old_link.account_id')
                  .whereRef('twin.relationship', '=', 'old_link.relationship')
                  .where('twin.person_id', '=', survivorId)
                  .where('twin.revoked_at', 'is', null),
              ),
              eb.and([
                eb('old_link.relationship', '=', 'self'),
                eb.exists(
                  eb
                    .selectFrom('person_account_links as twin')
                    .select('twin.id')
                    .whereRef('twin.org_id', '=', 'old_link.org_id')
                    .where('twin.person_id', '=', survivorId)
                    .where('twin.relationship', '=', 'self')
                    .where('twin.revoked_at', 'is', null),
                ),
              ]),
            ]),
          )
          .executeTakeFirst();
        const links = await trx
          .updateTable('person_account_links')
          .set({ person_id: survivorId })
          .where('org_id', '=', orgId)
          .where('person_id', '=', mergedId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        moved.person_account_links = Number(links.numUpdatedRows);
        if (Number(duplicateLinks.numUpdatedRows) > 0)
          moved.person_account_links_deduplicated = Number(
            duplicateLinks.numUpdatedRows,
          );

        const medical = await trx
          .updateTable('medical_profiles')
          .set({ person_id: survivorId })
          .where('org_id', '=', orgId)
          .where('person_id', '=', mergedId)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('medical_profiles as twin')
                  .select('twin.id')
                  .where('twin.org_id', '=', orgId)
                  .where('twin.person_id', '=', survivorId),
              ),
            ),
          )
          .executeTakeFirst();
        if (Number(medical.numUpdatedRows) > 0)
          moved.medical_profiles = Number(medical.numUpdatedRows);

        await trx
          .updateTable('team_entries')
          .set({ captain_person_id: survivorId })
          .where('org_id', '=', orgId)
          .where('captain_person_id', '=', mergedId)
          .execute();
        await trx
          .updateTable('people')
          .set({ merged_into_id: survivorId })
          .where('org_id', '=', orgId)
          .where('merged_into_id', '=', mergedId)
          .execute();
        await trx
          .updateTable('people')
          .set({
            status: 'merged',
            merged_into_id: survivorId,
            version: merged.version + 1,
          })
          .where('org_id', '=', orgId)
          .where('id', '=', mergedId)
          .execute();

        const mergeId = newId();
        const summary = {
          survivorName: `${survivor.first_name} ${survivor.last_name}`,
          mergedName: `${merged.first_name} ${merged.last_name}`,
          moved,
        };
        await trx
          .insertInto('person_merges')
          .values({
            id: mergeId,
            org_id: orgId,
            survivor_id: survivorId,
            merged_id: mergedId,
            summary,
            performed_by: actorId,
          })
          .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: actorId,
            action: 'person.merged',
            entity_type: 'person',
            entity_id: survivorId,
            changes: { mergeId, mergedId },
          })
          .execute();
        return personMergeResponseSchema.parse({
          id: mergeId,
          survivorId,
          mergedId,
          summary,
        });
      });
    },
  };
}
