import type { Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { ClassesAccessError } from './errors.js';

const STAFF_ROLES = [
  'owner',
  'admin',
  'director',
  'registrar',
  'scheduler',
] as const;
const MANAGER_ROLES = ['owner', 'admin', 'director'] as const;

async function hasRole(
  database: Kysely<DB>,
  context: OrgContext,
  roles: readonly string[],
): Promise<boolean> {
  return createWithOrg(database)(context, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!membership) return false;
    const role = await trx
      .selectFrom('role_assignments')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('role', 'in', roles)
      .where('scope_type', '=', 'org')
      .where('pending_mfa', '=', false)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Boolean(role);
  });
}

/** Staff that may view and operate academy classes (schedules, attendance, skills). */
export async function requireClassStaff(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<void> {
  if (!(await hasRole(database, context, STAFF_ROLES)))
    throw new ClassesAccessError();
}

/** Staff that may change money-affecting class settings and offerings. */
export async function requireClassManager(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<void> {
  if (!(await hasRole(database, context, MANAGER_ROLES)))
    throw new ClassesAccessError(
      'A director or administrator role is required',
    );
}

/**
 * Instructors mark attendance and record skill assessments for their own
 * sessions. The signed-in account must be linked to a person listed as an
 * instructor on the schedule that produced the session.
 */
async function requireSessionInstructor(
  database: Kysely<DB>,
  context: OrgContext,
  classSessionId: string,
): Promise<void> {
  const allowed = await createWithOrg(database)(context, async (trx) => {
    const row = await trx
      .selectFrom('class_sessions as session')
      .innerJoin('class_instructors as instructor', (join) =>
        join
          .onRef(
            'instructor.class_schedule_id',
            '=',
            'session.class_schedule_id',
          )
          .on('instructor.org_id', '=', context.orgId)
          .on('instructor.status', '=', 'active'),
      )
      .innerJoin('person_account_links as link', (join) =>
        join
          .onRef('link.person_id', '=', 'instructor.person_id')
          .on('link.org_id', '=', context.orgId)
          .on('link.account_id', '=', context.actor.accountId)
          .on('link.revoked_at', 'is', null),
      )
      .select('session.id')
      .where('session.org_id', '=', context.orgId)
      .where('session.id', '=', classSessionId)
      .executeTakeFirst();
    if (row) return true;
    const substitute = await trx
      .selectFrom('class_sessions as session')
      .innerJoin('person_account_links as link', (join) =>
        join
          .onRef('link.person_id', '=', 'session.substitute_person_id')
          .on('link.org_id', '=', context.orgId)
          .on('link.account_id', '=', context.actor.accountId)
          .on('link.revoked_at', 'is', null),
      )
      .select('session.id')
      .where('session.org_id', '=', context.orgId)
      .where('session.id', '=', classSessionId)
      .where('session.substitute_person_id', 'is not', null)
      .executeTakeFirst();
    return Boolean(substitute);
  });
  if (!allowed) throw new ClassesAccessError();
}

/** Staff OR the session's own instructor may run a session roster. */
export async function requireSessionStaffOrInstructor(
  database: Kysely<DB>,
  context: OrgContext,
  classSessionId: string,
): Promise<void> {
  try {
    await requireClassStaff(database, context);
    return;
  } catch {
    await requireSessionInstructor(database, context, classSessionId);
  }
}

/** The signed-in account must be a verified guardian of the person. */
export async function requireGuardian(
  database: Kysely<DB>,
  context: OrgContext,
  personId: string,
): Promise<void> {
  const allowed = await createWithOrg(database)(context, async (trx) => {
    const link = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('person_id', '=', personId)
      .where('relationship', '=', 'guardian')
      .where('verified_at', 'is not', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Boolean(link);
  });
  if (!allowed)
    throw new ClassesAccessError('A verified guardian link is required');
}

/** The account must be linked to the person (self or guardian). */
export async function requireLinkedPerson(
  database: Kysely<DB>,
  context: OrgContext,
  personId: string,
): Promise<void> {
  const allowed = await createWithOrg(database)(context, async (trx) => {
    const link = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('person_id', '=', personId)
      .where('verified_at', 'is not', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Boolean(link);
  });
  if (!allowed)
    throw new ClassesAccessError('The person is not linked to this account');
}

/** The account must be an active member of the org. */
export async function requireMember(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<void> {
  const allowed = await createWithOrg(database)(context, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (membership) return true;
    const linkedPerson = await trx
      .selectFrom('person_account_links as link')
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'link.org_id')
          .onRef('person.id', '=', 'link.person_id'),
      )
      .select('link.id')
      .where('link.org_id', '=', context.orgId)
      .where('link.account_id', '=', context.actor.accountId)
      .where('link.verified_at', 'is not', null)
      .where('link.revoked_at', 'is', null)
      .where('person.status', '=', 'active')
      .executeTakeFirst();
    return Boolean(linkedPerson);
  });
  if (!allowed) throw new ClassesAccessError();
}
