import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { decryptRestricted, encryptRestricted } from '../../lib/crypto';
import {
  auditRestrictedRead,
  ComplianceServiceError,
} from '../compliance/service';
import type { ComplianceDependencies } from '../compliance/service';

export type SafetyDependencies = Pick<
  ComplianceDependencies,
  'database' | 'encryption' | 'clock'
>;

async function isComplianceActor(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<boolean> {
  const role = await trx
    .selectFrom('role_assignments')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('role', 'in', ['owner', 'compliance'])
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .executeTakeFirst();
  return Boolean(role);
}

async function personAccessible(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
): Promise<boolean> {
  return Boolean(
    await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', personId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst(),
  );
}

async function staffHasRosterAccess(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
): Promise<boolean> {
  const staff = await trx
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
    .where('staff.org_id', '=', context.orgId)
    .where('staff.status', '=', 'active')
    .where('roster.person_id', '=', personId)
    .where('roster.status', 'in', ['active', 'injured'])
    .where('actor.account_id', '=', context.actor.accountId)
    .where('actor.relationship', '=', 'self')
    .where('actor.revoked_at', 'is', null)
    .executeTakeFirst();
  return Boolean(staff);
}

async function validateFile(
  trx: OrgTransaction,
  orgId: string,
  fileId: string,
): Promise<void> {
  const file = await trx
    .selectFrom('files')
    .select(['id', 'sensitivity', 'upload_state', 'deleted_at'])
    .where('org_id', '=', orgId)
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (
    !file ||
    file.sensitivity !== 'restricted' ||
    file.upload_state !== 'complete' ||
    file.deleted_at
  )
    throw new ComplianceServiceError(
      400,
      'FILE_INVALID',
      'Use a completed restricted document from this organization',
    );
}

export async function reportInjury(
  dependencies: SafetyDependencies,
  context: OrgContext,
  input: {
    personId: string;
    eventId?: string | null;
    occurredAt: string;
    bodyPart?: string | null;
    injuryType?: string | null;
    suspectedConcussion: boolean;
    description: string;
  },
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const person = await trx
      .selectFrom('people')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.personId)
      .executeTakeFirst();
    if (!person)
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Person not found');
    if (input.eventId) {
      const event = await trx
        .selectFrom('events')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.eventId)
        .executeTakeFirst();
      if (!event)
        throw new ComplianceServiceError(404, 'NOT_FOUND', 'Event not found');
    }
    const privileged = await isComplianceActor(trx, context);
    const staff = await staffHasRosterAccess(trx, context, input.personId);
    const relationship = await personAccessible(trx, context, input.personId);
    if (!privileged && !staff && !relationship)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Injury report access denied',
      );
    const id = newId();
    await trx
      .insertInto('injury_reports')
      .values({
        id,
        org_id: context.orgId,
        person_id: input.personId,
        event_id: input.eventId ?? null,
        occurred_at: new Date(input.occurredAt),
        body_part: input.bodyPart ?? null,
        injury_type: input.injuryType ?? null,
        is_suspected_concussion: input.suspectedConcussion,
        description_enc: input.description
          ? encryptRestricted(
              Buffer.from(input.description),
              dependencies.encryption,
            )
          : null,
        reported_by: context.actor.accountId,
        status: 'open',
      })
      .execute();
    const guardians = await trx
      .selectFrom('person_account_links')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', input.personId)
      .where('relationship', '=', 'guardian')
      .where('revoked_at', 'is', null)
      .execute();
    for (const guardian of guardians) {
      await trx
        .insertInto('notifications')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: guardian.account_id,
          type: 'safety.injury_reported',
          payload: {
            personId: input.personId,
            injuryReportId: id,
            status: 'open',
          },
        })
        .execute();
    }
    if (guardians.length) {
      await trx
        .updateTable('injury_reports')
        .set({ guardian_notified_at: dependencies.clock() })
        .where('org_id', '=', context.orgId)
        .where('id', '=', id)
        .execute();
    }
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: 'injury_report.created',
        entity_type: 'injury_report',
        entity_id: id,
        changes: {
          personId: input.personId,
          eventId: input.eventId ?? null,
          suspectedConcussion: input.suspectedConcussion,
          description: '[redacted]',
        },
      })
      .execute();
    return {
      id,
      status: 'open',
      suspectedConcussion: input.suspectedConcussion,
      rosterStatus: input.suspectedConcussion ? 'injured' : null,
    };
  });
}

export async function listInjuries(
  dependencies: SafetyDependencies,
  context: OrgContext,
  personId: string,
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const privileged = await isComplianceActor(trx, context);
    const relationship = await personAccessible(trx, context, personId);
    const staff = await staffHasRosterAccess(trx, context, personId);
    if (!privileged && !relationship && !staff)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Injury history not found',
      );
    const rows = await trx
      .selectFrom('injury_reports')
      .select([
        'id',
        'person_id as personId',
        'event_id as eventId',
        'occurred_at as occurredAt',
        'body_part as bodyPart',
        'injury_type as injuryType',
        'is_suspected_concussion as suspectedConcussion',
        'description_enc',
        'reported_by as reportedBy',
        'guardian_notified_at as guardianNotifiedAt',
        'status',
        'version',
      ])
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', personId)
      .orderBy('occurred_at', 'desc')
      .execute();
    for (const row of rows)
      await auditRestrictedRead(trx, context, 'injury_report', row.id, [
        'description_enc',
        'body_part',
        'injury_type',
      ]);
    return rows.map(({ description_enc: descriptionEnc, ...row }) => ({
      ...row,
      description: descriptionEnc
        ? decryptRestricted(descriptionEnc, dependencies.encryption).toString(
            'utf8',
          )
        : '',
    }));
  });
}

export async function submitClearance(
  dependencies: SafetyDependencies,
  context: OrgContext,
  input: {
    injuryReportId: string;
    fileId: string;
    providerName: string;
    clearedOn: string;
  },
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const injury = await trx
      .selectFrom('injury_reports')
      .select(['id', 'person_id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.injuryReportId)
      .executeTakeFirst();
    if (!injury)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Injury report not found',
      );
    if (!['open', 'return_to_play_pending'].includes(injury.status))
      throw new ComplianceServiceError(
        409,
        'INVALID_STATE',
        'This injury does not need a clearance',
      );
    const compliance = await isComplianceActor(trx, context);
    if (
      !compliance &&
      !(await personAccessible(trx, context, injury.person_id)) &&
      !(await staffHasRosterAccess(trx, context, injury.person_id))
    )
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Injury report not found',
      );
    await validateFile(trx, context.orgId, input.fileId);
    const id = newId();
    await trx
      .insertInto('return_to_play_clearances')
      .values({
        id,
        org_id: context.orgId,
        injury_report_id: input.injuryReportId,
        clearance_file_id: input.fileId,
        cleared_by_provider_name: input.providerName,
        cleared_on: input.clearedOn,
        recorded_by: context.actor.accountId,
        review_status: 'pending_review',
      })
      .execute();
    await trx
      .updateTable('injury_reports')
      .set({
        status: 'return_to_play_pending',
        version: sql<number>`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.injuryReportId)
      .where('status', '=', injury.status)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: 'return_to_play.clearance.submitted',
        entity_type: 'return_to_play_clearance',
        entity_id: id,
        changes: {
          injuryReportId: input.injuryReportId,
          clearanceFileId: input.fileId,
          providerName: '[redacted]',
        },
      })
      .execute();
    return { id, reviewStatus: 'pending_review' };
  });
}

export async function listClearanceReviews(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('return_to_play_clearances as clearance')
      .innerJoin('injury_reports as injury', (join) =>
        join
          .onRef('injury.org_id', '=', 'clearance.org_id')
          .onRef('injury.id', '=', 'clearance.injury_report_id'),
      )
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'injury.org_id')
          .onRef('person.id', '=', 'injury.person_id'),
      )
      .select([
        'clearance.id',
        'clearance.injury_report_id as injuryReportId',
        'injury.person_id as personId',
        'person.first_name as firstName',
        'person.last_name as lastName',
        'clearance.clearance_file_id as clearanceFileId',
        'clearance.cleared_by_provider_name as providerName',
        'clearance.cleared_on as clearedOn',
        'clearance.review_status as reviewStatus',
        'clearance.version',
      ])
      .where('clearance.org_id', '=', context.orgId)
      .where('clearance.review_status', '=', 'pending_review')
      .orderBy('clearance.created_at')
      .execute();
    for (const row of rows)
      await auditRestrictedRead(
        trx,
        context,
        'return_to_play_clearance',
        row.id,
        ['clearance_file_id'],
      );
    return rows;
  });
}

export async function reviewClearance(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    clearanceId: string;
    decision: 'approve' | 'reject';
    reason?: string;
    version: number;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const clearance = await trx
      .selectFrom('return_to_play_clearances')
      .select([
        'id',
        'injury_report_id',
        'clearance_file_id',
        'review_status',
        'version',
      ])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.clearanceId)
      .executeTakeFirst();
    if (!clearance)
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Clearance not found');
    if (
      clearance.version !== input.version ||
      clearance.review_status !== 'pending_review'
    )
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Clearance changed; reload before reviewing',
      );
    if (input.decision === 'reject' && !input.reason?.trim())
      throw new ComplianceServiceError(
        400,
        'VALIDATION_ERROR',
        'A rejection reason is required',
      );
    await auditRestrictedRead(
      trx,
      context,
      'return_to_play_clearance',
      clearance.id,
      ['clearance_file_id'],
    );
    const reviewStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    await trx
      .updateTable('return_to_play_clearances')
      .set({
        review_status: reviewStatus,
        reviewed_by: context.actor.accountId,
        reviewed_at: new Date(),
        rejection_reason: input.reason ?? null,
        version: input.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.clearanceId)
      .where('version', '=', input.version)
      .execute();
    if (input.decision === 'approve') {
      await trx
        .updateTable('injury_reports')
        .set({ status: 'cleared', version: sql<number>`version + 1` })
        .where('org_id', '=', context.orgId)
        .where('id', '=', clearance.injury_report_id)
        .where('status', '=', 'return_to_play_pending')
        .execute();
    }
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: `return_to_play.clearance.${input.decision}d`,
        entity_type: 'return_to_play_clearance',
        entity_id: clearance.id,
        changes: {
          status: reviewStatus,
          reason: input.reason ? '[redacted]' : null,
          file: '[redacted]',
        },
      })
      .execute();
    return { id: clearance.id, reviewStatus, version: input.version + 1 };
  });
}

export async function reportIncident(
  dependencies: SafetyDependencies,
  context: OrgContext,
  input: {
    category:
      'safety' | 'behavior' | 'safesport_concern' | 'facility' | 'other';
    occurredAt: string;
    eventId?: string | null;
    peopleInvolved: string[];
    narrative: string;
  },
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const member = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const linked = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (!member && !linked)
      throw new ComplianceServiceError(
        404,
        'NOT_FOUND',
        'Organization not found',
      );
    if (input.eventId) {
      const event = await trx
        .selectFrom('events')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.eventId)
        .executeTakeFirst();
      if (!event)
        throw new ComplianceServiceError(404, 'NOT_FOUND', 'Event not found');
    }
    if (input.peopleInvolved.length) {
      const people = await trx
        .selectFrom('people')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', 'in', input.peopleInvolved)
        .execute();
      if (people.length !== new Set(input.peopleInvolved).size)
        throw new ComplianceServiceError(
          404,
          'NOT_FOUND',
          'Incident participant not found',
        );
    }
    const id = newId();
    const restricted = input.category === 'safesport_concern';
    await trx
      .insertInto('incident_reports')
      .values({
        id,
        org_id: context.orgId,
        category: input.category,
        occurred_at: new Date(input.occurredAt),
        event_id: input.eventId ?? null,
        people_involved: input.peopleInvolved,
        narrative_enc: encryptRestricted(
          Buffer.from(input.narrative),
          dependencies.encryption,
        ),
        reported_by: context.actor.accountId,
        status: 'open',
        restricted,
      })
      .execute();
    const officers = await trx
      .selectFrom('role_assignments')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where(
        'role',
        'in',
        restricted ? ['owner', 'compliance'] : ['owner', 'admin', 'compliance'],
      )
      .where('scope_type', '=', 'org')
      .where('revoked_at', 'is', null)
      .where('pending_mfa', '=', false)
      .execute();
    for (const officer of officers) {
      await trx
        .insertInto('notifications')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: officer.account_id,
          type: restricted
            ? 'safety.safesport_concern_reported'
            : 'safety.incident_reported',
          payload: { incidentId: id, category: input.category, restricted },
        })
        .execute();
    }
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: 'incident_report.created',
        entity_type: 'incident_report',
        entity_id: id,
        changes: {
          category: input.category,
          eventId: input.eventId ?? null,
          peopleInvolved: input.peopleInvolved,
          narrative: '[redacted]',
          restricted,
        },
      })
      .execute();
    return { id, category: input.category, status: 'open', restricted };
  });
}

export async function listIncidents(
  database: Kysely<DB>,
  context: OrgContext,
  access: { canReview: boolean; canReadRestricted: boolean },
) {
  return createWithOrg(database)(context, async (trx) => {
    let query = trx
      .selectFrom('incident_reports')
      .select([
        'id',
        'category',
        'occurred_at as occurredAt',
        'event_id as eventId',
        'reported_by as reportedBy',
        'status',
        'restricted',
        'version',
      ])
      .where('org_id', '=', context.orgId);
    if (!access.canReview)
      query = query
        .where('reported_by', '=', context.actor.accountId)
        .where('restricted', '=', false);
    else if (!access.canReadRestricted)
      query = query.where('restricted', '=', false);
    const rows = await query.orderBy('occurred_at', 'desc').execute();
    for (const row of rows) {
      if (row.restricted || access.canReview)
        await auditRestrictedRead(trx, context, 'incident_report', row.id, [
          'narrative_enc',
          'resolution_enc',
        ]);
    }
    return rows;
  });
}

export async function readIncident(
  dependencies: SafetyDependencies,
  context: OrgContext,
  incidentId: string,
  access: { canReview: boolean; canReadRestricted: boolean },
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const row = await trx
      .selectFrom('incident_reports')
      .select([
        'id',
        'category',
        'occurred_at as occurredAt',
        'event_id as eventId',
        'people_involved as peopleInvolved',
        'narrative_enc',
        'reported_by as reportedBy',
        'status',
        'restricted',
        'resolution_enc',
        'version',
      ])
      .where('org_id', '=', context.orgId)
      .where('id', '=', incidentId)
      .executeTakeFirst();
    if (
      !row ||
      (row.restricted && !access.canReadRestricted) ||
      (!access.canReview && row.reportedBy !== context.actor.accountId)
    )
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Incident not found');
    await auditRestrictedRead(trx, context, 'incident_report', row.id, [
      'narrative_enc',
      'resolution_enc',
    ]);
    return {
      id: row.id,
      category: row.category,
      occurredAt: row.occurredAt,
      eventId: row.eventId,
      peopleInvolved: row.peopleInvolved,
      reportedBy: row.reportedBy,
      status: row.status,
      narrative: decryptRestricted(
        row.narrative_enc,
        dependencies.encryption,
      ).toString('utf8'),
      resolution: row.resolution_enc
        ? decryptRestricted(
            row.resolution_enc,
            dependencies.encryption,
          ).toString('utf8')
        : null,
      restricted: row.restricted,
      version: row.version,
    };
  });
}

export async function updateIncident(
  dependencies: SafetyDependencies,
  context: OrgContext,
  input: {
    incidentId: string;
    status: 'open' | 'under_review' | 'closed';
    resolution?: string | null;
    version: number;
  },
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const row = await trx
      .selectFrom('incident_reports')
      .select(['id', 'version', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.incidentId)
      .executeTakeFirst();
    if (!row)
      throw new ComplianceServiceError(404, 'NOT_FOUND', 'Incident not found');
    if (row.version !== input.version)
      throw new ComplianceServiceError(
        409,
        'CONFLICT',
        'Incident changed; reload before updating',
      );
    if (input.status === 'closed' && !input.resolution?.trim())
      throw new ComplianceServiceError(
        400,
        'VALIDATION_ERROR',
        'A resolution is required to close an incident',
      );
    const resolutionEnc = input.resolution
      ? encryptRestricted(
          Buffer.from(input.resolution),
          dependencies.encryption,
        )
      : null;
    await trx
      .updateTable('incident_reports')
      .set({
        status: input.status,
        resolution_enc: resolutionEnc ?? undefined,
        version: input.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.incidentId)
      .where('version', '=', input.version)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: 'incident_report.updated',
        entity_type: 'incident_report',
        entity_id: input.incidentId,
        changes: {
          from: row.status,
          to: input.status,
          resolution: input.resolution ? '[redacted]' : null,
        },
      })
      .execute();
    return {
      id: input.incidentId,
      status: input.status,
      version: input.version + 1,
    };
  });
}
