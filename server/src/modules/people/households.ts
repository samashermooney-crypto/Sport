import { newId } from '@shared/ids';
import { householdResponseSchema } from '@shared/schemas/households';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';

import { PeopleError, requireStaff } from './repo';

type Household = z.output<typeof householdResponseSchema>;
type Create = z.output<
  typeof import('@shared/schemas/households').householdCreateSchema
>;
type Update = z.output<
  typeof import('@shared/schemas/households').householdUpdateSchema
>;
type Member = z.output<
  typeof import('@shared/schemas/households').householdMemberCreateSchema
>;
type MemberUpdate = z.output<
  typeof import('@shared/schemas/households').householdMemberUpdateSchema
>;
type ListQuery = z.output<
  typeof import('@shared/schemas/households').householdsQuerySchema
>;

async function view(
  trx: OrgTransaction,
  orgId: string,
  householdId: string,
): Promise<Household> {
  const household = await trx
    .selectFrom('households')
    .select(['id', 'org_id', 'name', 'address', 'status', 'version'])
    .where('org_id', '=', orgId)
    .where('id', '=', householdId)
    .executeTakeFirst();
  if (!household)
    throw new PeopleError(404, 'NOT_FOUND', 'Household not found');
  const [members, registrations, invoices] = await Promise.all([
    trx
      .selectFrom('household_members')
      .innerJoin('people', (join) =>
        join
          .onRef('people.org_id', '=', 'household_members.org_id')
          .onRef('people.id', '=', 'household_members.person_id'),
      )
      .select([
        'household_members.id',
        'household_members.person_id',
        'people.first_name',
        'people.last_name',
        'household_members.role',
        'household_members.is_primary_contact',
        'household_members.receives_communications',
        'household_members.financially_responsible',
        'household_members.can_pick_up',
        'household_members.lives_here',
      ])
      .where('household_members.org_id', '=', orgId)
      .where('household_members.household_id', '=', householdId)
      .where('household_members.removed_at', 'is', null)
      .orderBy('people.last_name')
      .orderBy('people.first_name')
      .execute(),
    trx
      .selectFrom('registrations')
      .select(['id', 'person_id', 'program_id', 'status'])
      .where('org_id', '=', orgId)
      .where('household_id', '=', householdId)
      .orderBy('created_at', 'desc')
      .execute(),
    trx
      .selectFrom('invoices')
      .select(['currency', 'balance_cents'])
      .where('org_id', '=', orgId)
      .where('household_id', '=', householdId)
      .where('status', 'not in', ['void', 'draft'])
      .execute(),
  ]);
  return householdResponseSchema.parse({
    id: household.id,
    orgId: household.org_id,
    name: household.name,
    address: household.address,
    status: household.status,
    version: household.version,
    balances: Object.entries(
      invoices.reduce<Record<string, number>>((totals, invoice) => {
        totals[invoice.currency] =
          (totals[invoice.currency] ?? 0) + (invoice.balance_cents ?? 0);
        return totals;
      }, {}),
    ).map(([currency, amountCents]) => ({ currency, amountCents })),
    members: members.map((member) => ({
      id: member.id,
      personId: member.person_id,
      firstName: member.first_name,
      lastName: member.last_name,
      role: member.role,
      isPrimaryContact: member.is_primary_contact,
      receivesCommunications: member.receives_communications,
      financiallyResponsible: member.financially_responsible,
      canPickUp: member.can_pick_up,
      livesHere: member.lives_here,
    })),
    registrations: registrations.map((registration) => ({
      id: registration.id,
      personId: registration.person_id,
      programId: registration.program_id,
      status: registration.status,
    })),
  });
}

async function audit(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  householdId: string,
  action: string,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: newId(),
      org_id: orgId,
      actor_account_id: actorId,
      action,
      entity_type: 'household',
      entity_id: householdId,
      changes: {},
    })
    .execute();
}

export function createHouseholdsRepository(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);
  return {
    async list(
      orgId: string,
      actorId: string,
      filters: ListQuery = {},
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, impersonating);
        let query = trx
          .selectFrom('households')
          .select('id')
          .where('org_id', '=', orgId)
          .where('status', '=', 'active');
        if (filters.cursor) query = query.where('id', '>', filters.cursor);
        if (filters.q) {
          const term = `%${filters.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
          query = query.where('name', 'ilike', term);
        }
        const rows = await query.orderBy('id').limit(31).execute();
        const page = rows.slice(0, 30);
        return {
          items: await Promise.all(page.map((row) => view(trx, orgId, row.id))),
          nextCursor: rows.length > 30 ? (page.at(-1)?.id ?? null) : null,
        };
      });
    },
    async get(
      orgId: string,
      actorId: string,
      householdId: string,
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, impersonating);
        return view(trx, orgId, householdId);
      });
    },
    async create(orgId: string, actorId: string, input: Create) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const id = newId();
        await trx
          .insertInto('households')
          .values({
            id,
            org_id: orgId,
            name: input.name,
            address: input.address,
          })
          .execute();
        await audit(trx, orgId, actorId, id, 'household.created');
        return view(trx, orgId, id);
      });
    },
    async update(
      orgId: string,
      actorId: string,
      householdId: string,
      input: Update,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const row = await trx
          .updateTable('households')
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.address !== undefined ? { address: input.address } : {}),
            version: (eb) => eb('version', '+', 1),
          })
          .where('org_id', '=', orgId)
          .where('id', '=', householdId)
          .where('version', '=', input.expectedVersion)
          .where('status', '=', 'active')
          .returning('id')
          .executeTakeFirst();
        if (!row)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Household changed; reload before saving',
          );
        await audit(trx, orgId, actorId, householdId, 'household.updated');
        return view(trx, orgId, householdId);
      });
    },
    async addMember(
      orgId: string,
      actorId: string,
      householdId: string,
      input: Member,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const household = await trx
          .selectFrom('households')
          .select('id')
          .where('org_id', '=', orgId)
          .where('id', '=', householdId)
          .where('status', '=', 'active')
          .forUpdate()
          .executeTakeFirst();
        if (!household)
          throw new PeopleError(404, 'NOT_FOUND', 'Household not found');
        const person = await trx
          .selectFrom('people')
          .select('id')
          .where('org_id', '=', orgId)
          .where('id', '=', input.personId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!person)
          throw new PeopleError(404, 'NOT_FOUND', 'Person not found');
        if (
          input.isPrimaryContact &&
          !['guardian', 'other_adult'].includes(input.role)
        )
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'Primary contact must be an adult',
          );
        const existing = await trx
          .selectFrom('household_members')
          .select('id')
          .where('org_id', '=', orgId)
          .where('household_id', '=', householdId)
          .where('person_id', '=', input.personId)
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (existing)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Person already belongs to household',
          );
        if (input.isPrimaryContact)
          await trx
            .updateTable('household_members')
            .set({ is_primary_contact: false })
            .where('org_id', '=', orgId)
            .where('household_id', '=', householdId)
            .where('removed_at', 'is', null)
            .execute();
        await trx
          .insertInto('household_members')
          .values({
            id: newId(),
            org_id: orgId,
            household_id: householdId,
            person_id: input.personId,
            role: input.role,
            is_primary_contact: input.isPrimaryContact,
            receives_communications: input.receivesCommunications,
            financially_responsible: input.financiallyResponsible,
            can_pick_up: input.canPickUp,
            lives_here: input.livesHere,
          })
          .execute();
        await trx
          .updateTable('households')
          .set({ version: (eb) => eb('version', '+', 1) })
          .where('org_id', '=', orgId)
          .where('id', '=', householdId)
          .execute();
        await audit(trx, orgId, actorId, householdId, 'household.member_added');
        return view(trx, orgId, householdId);
      });
    },
    async updateMember(
      orgId: string,
      actorId: string,
      householdId: string,
      memberId: string,
      input: MemberUpdate,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const household = await trx
          .selectFrom('households')
          .select('version')
          .where('org_id', '=', orgId)
          .where('id', '=', householdId)
          .where('status', '=', 'active')
          .forUpdate()
          .executeTakeFirst();
        if (!household)
          throw new PeopleError(404, 'NOT_FOUND', 'Household not found');
        if (household.version !== input.expectedVersion)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Household changed; reload before editing members',
          );
        const current = await trx
          .selectFrom('household_members')
          .select(['id', 'role', 'is_primary_contact'])
          .where('org_id', '=', orgId)
          .where('household_id', '=', householdId)
          .where('id', '=', memberId)
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!current)
          throw new PeopleError(404, 'NOT_FOUND', 'Member not found');
        const role = input.role ?? current.role;
        const primary = input.isPrimaryContact ?? current.is_primary_contact;
        if (primary && !['guardian', 'other_adult'].includes(role))
          throw new PeopleError(
            400,
            'VALIDATION_ERROR',
            'Primary contact must be an adult',
          );
        if (current.is_primary_contact && !primary)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Assign another primary contact first',
          );
        if (primary && !current.is_primary_contact)
          await trx
            .updateTable('household_members')
            .set({ is_primary_contact: false })
            .where('org_id', '=', orgId)
            .where('household_id', '=', householdId)
            .where('removed_at', 'is', null)
            .execute();
        await trx
          .updateTable('household_members')
          .set({
            ...(input.role !== undefined ? { role: input.role } : {}),
            ...(input.isPrimaryContact !== undefined
              ? { is_primary_contact: input.isPrimaryContact }
              : {}),
            ...(input.receivesCommunications !== undefined
              ? { receives_communications: input.receivesCommunications }
              : {}),
            ...(input.financiallyResponsible !== undefined
              ? { financially_responsible: input.financiallyResponsible }
              : {}),
            ...(input.canPickUp !== undefined
              ? { can_pick_up: input.canPickUp }
              : {}),
            ...(input.livesHere !== undefined
              ? { lives_here: input.livesHere }
              : {}),
          })
          .where('org_id', '=', orgId)
          .where('household_id', '=', householdId)
          .where('id', '=', memberId)
          .where('removed_at', 'is', null)
          .execute();
        await trx
          .updateTable('households')
          .set({ version: (eb) => eb('version', '+', 1) })
          .where('org_id', '=', orgId)
          .where('id', '=', householdId)
          .execute();
        await audit(
          trx,
          orgId,
          actorId,
          householdId,
          'household.member_updated',
        );
        return view(trx, orgId, householdId);
      });
    },
    async removeMember(
      orgId: string,
      actorId: string,
      householdId: string,
      memberId: string,
      expectedVersion: number,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireStaff(trx, orgId, actorId, false);
        const household = await trx
          .selectFrom('households')
          .select('version')
          .where('org_id', '=', orgId)
          .where('id', '=', householdId)
          .where('status', '=', 'active')
          .forUpdate()
          .executeTakeFirst();
        if (!household)
          throw new PeopleError(404, 'NOT_FOUND', 'Household not found');
        if (household.version !== expectedVersion)
          throw new PeopleError(
            409,
            'CONFLICT',
            'Household changed; reload before removing members',
          );
        const member = await trx
          .selectFrom('household_members')
          .select(['id', 'is_primary_contact'])
          .where('org_id', '=', orgId)
          .where('household_id', '=', householdId)
          .where('id', '=', memberId)
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (!member)
          throw new PeopleError(404, 'NOT_FOUND', 'Member not found');
        if (member.is_primary_contact) {
          const other = await trx
            .selectFrom('household_members')
            .select('id')
            .where('org_id', '=', orgId)
            .where('household_id', '=', householdId)
            .where('id', '!=', memberId)
            .where('removed_at', 'is', null)
            .executeTakeFirst();
          if (other)
            throw new PeopleError(
              409,
              'CONFLICT',
              'Assign another primary contact first',
            );
        }
        await trx
          .updateTable('household_members')
          .set({ removed_at: new Date() })
          .where('org_id', '=', orgId)
          .where('household_id', '=', householdId)
          .where('id', '=', memberId)
          .where('removed_at', 'is', null)
          .execute();
        await trx
          .updateTable('households')
          .set({ version: (eb) => eb('version', '+', 1) })
          .where('org_id', '=', orgId)
          .where('id', '=', householdId)
          .execute();
        await audit(
          trx,
          orgId,
          actorId,
          householdId,
          'household.member_removed',
        );
        return view(trx, orgId, householdId);
      });
    },
  };
}
