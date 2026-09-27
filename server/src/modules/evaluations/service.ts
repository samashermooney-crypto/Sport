import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { scoreEvaluations } from '@shared/algorithms/evaluation';
import type {
  EvaluationAthlete,
  EvaluationCriterion,
  EvaluationScore,
} from '@shared/algorithms/evaluation';
import { balanceTeams } from '@shared/algorithms/team-balancer';
import { rubricCriterionSchema } from '@shared/sport/schema';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { createNotification } from '../notifications/service';

import type {
  BoardCreateInput,
  EvaluationCreate,
  EvaluationSessionInput,
  ParticipantInput,
  PlacementPreferenceInput,
  ScoreInput,
} from './schemas';

export type EvaluationDependencies = {
  database: Kysely<DB>;
  clock: () => Date;
};

export type AcceptedOfferCheckout = {
  registrationId: string;
  checkoutId: string;
  invoiceId: string;
  depositCents: number;
  paymentPlanId: string | null;
};

/** Track E's adapter owns registration, invoice and deposit writes for an offer. */
export interface OfferCheckoutAdapter {
  accept(input: {
    orgId: string;
    offerId: string;
    accountId: string;
    householdId: string;
    personId: string;
    offeringId: string;
    teamSeasonId: string;
    amountCents: number;
    depositCents: number;
    idempotencyKey: string;
  }): Promise<AcceptedOfferCheckout>;
}

export class EvaluationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;
const dateOnly = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);

async function eventRow(trx: OrgTransaction, orgId: string, id: string) {
  return sql<{
    id: string;
    tryout_program_id: string;
    target_program_id: string;
    name: string;
    status: string;
    normalization: 'none' | 'z_score_per_evaluator';
    share_results_with_families: boolean;
    version: number;
  }>`SELECT id,tryout_program_id,target_program_id,name,status,normalization,
      share_results_with_families,version FROM evaluation_events
    WHERE org_id=${orgId} AND id=${id}`
    .execute(trx)
    .then((result) => result.rows[0]);
}

export async function createEvaluationEvent(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  input: EvaluationCreate,
) {
  if (
    new Set(input.criteria.map((item) => item.key)).size !==
    input.criteria.length
  )
    throw new EvaluationError(
      422,
      'INVALID_RUBRIC',
      'Criterion keys must be unique',
    );
  if (input.criteria.some((item) => item.scaleMax <= item.scaleMin))
    throw new EvaluationError(
      422,
      'INVALID_RUBRIC',
      'Each score scale must have a maximum above its minimum',
    );
  if (
    new Set(input.groups.map((item) => item.name)).size !== input.groups.length
  )
    throw new EvaluationError(
      422,
      'INVALID_GROUPS',
      'Group names must be unique',
    );

  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const programs = await sql<{
      id: string;
      mode: string;
      sport_profile_id: string;
    }>`
      SELECT id,mode,sport_profile_id FROM programs
      WHERE org_id=${context.orgId} AND id IN (${sql.join([input.tryoutProgramId, input.targetProgramId].map((id) => sql`${id}::uuid`))})
    `.execute(trx);
    const tryout = programs.rows.find(
      (row) => row.id === input.tryoutProgramId,
    );
    const target = programs.rows.find(
      (row) => row.id === input.targetProgramId,
    );
    if (
      !tryout ||
      !target ||
      tryout.mode !== 'tryout' ||
      tryout.id === target.id
    )
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Tryout and target programs were not found',
      );
    if (!['club', 'league'].includes(target.mode))
      throw new EvaluationError(
        422,
        'INVALID_TARGET_PROGRAM',
        'Evaluation placements require a club or league target program',
      );
    if (tryout.sport_profile_id !== target.sport_profile_id)
      throw new EvaluationError(
        422,
        'SPORT_PROFILE_MISMATCH',
        'Tryout and target program must use the same sport profile',
      );

    const id = randomUUID();
    await sql`INSERT INTO evaluation_events
      (id,org_id,tryout_program_id,target_program_id,name,normalization,share_results_with_families)
      VALUES (${id},${context.orgId},${input.tryoutProgramId},${input.targetProgramId},${input.name},${input.normalization},${input.shareResultsWithFamilies})`.execute(
      trx,
    );
    for (const [index, item] of input.criteria.entries()) {
      await sql`INSERT INTO evaluation_criteria
        (id,org_id,evaluation_event_id,criterion_key,label,weight,scale_min,scale_max,position_specific,position_keys,sort_order)
        VALUES (${randomUUID()},${context.orgId},${id},${item.key},${item.label},${item.weight},${item.scaleMin},${item.scaleMax},${item.positionSpecific},${item.positionKeys},${index})`.execute(
        trx,
      );
    }
    for (const [index, item] of input.groups.entries()) {
      if (
        item.ageMinMonths !== null &&
        item.ageMaxMonths !== null &&
        item.ageMaxMonths < item.ageMinMonths
      )
        throw new EvaluationError(
          422,
          'INVALID_GROUPS',
          'Group maximum age must not be below minimum age',
        );
      await sql`INSERT INTO evaluation_groups
        (id,org_id,evaluation_event_id,name,age_min_months,age_max_months,gender,position_keys,sort_order)
        VALUES (${randomUUID()},${context.orgId},${id},${item.name},${item.ageMinMonths},${item.ageMaxMonths},${item.gender},${item.positionKeys},${index})`.execute(
        trx,
      );
    }
    await appendAuditEvent(trx, context, {
      action: 'evaluation.created',
      entityType: 'evaluation_event',
      entityId: id,
      changes: {
        status: { tier: 'internal', after: 'draft' },
        targetProgramId: { tier: 'internal', after: input.targetProgramId },
      },
    });
    return eventRow(trx, context.orgId, id);
  });
}

export async function createEvaluationSession(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
  input: EvaluationSessionInput,
) {
  if (new Date(input.endsAt) <= new Date(input.startsAt))
    throw new EvaluationError(
      422,
      'INVALID_SESSION',
      'Session end must follow its start',
    );
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const event = await eventRow(trx, context.orgId, eventId);
    if (!event)
      throw new EvaluationError(404, 'NOT_FOUND', 'Evaluation event not found');
    if (event.status !== 'draft' && event.status !== 'registration_open')
      throw new EvaluationError(
        409,
        'EVENT_LOCKED',
        'Sessions cannot be changed after scoring starts',
      );
    if (input.groupId) {
      const group = await sql<{ id: string }>`SELECT id FROM evaluation_groups
        WHERE org_id=${context.orgId} AND id=${input.groupId} AND evaluation_event_id=${eventId}`.execute(
        trx,
      );
      if (!group.rows[0])
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Evaluation group not found',
        );
    }
    const id = randomUUID();
    const calendarEventId = randomUUID();
    let location: string | null = null;
    if (input.facilityId) {
      const facility = await sql<{ name: string }>`SELECT name FROM facilities
        WHERE org_id=${context.orgId} AND id=${input.facilityId}`.execute(trx);
      location = facility.rows[0]?.name ?? null;
    }
    await sql`INSERT INTO events
      (id,org_id,program_id,kind,title,starts_at,ends_at,timezone,location_text,status,published,arrival_minutes_before)
      VALUES (${calendarEventId},${context.orgId},${event.tryout_program_id},'evaluation_session',${input.name},${input.startsAt},${input.endsAt},${input.timezone},${location},'scheduled',false,0)`.execute(
      trx,
    );
    await sql`INSERT INTO evaluation_sessions
      (id,org_id,evaluation_event_id,evaluation_group_id,calendar_event_id,name,starts_at,ends_at,timezone,facility_id,capacity)
      VALUES (${id},${context.orgId},${eventId},${input.groupId},${calendarEventId},${input.name},${input.startsAt},${input.endsAt},${input.timezone},${input.facilityId},${input.capacity})`.execute(
      trx,
    );
    await sql`UPDATE evaluation_events SET status='registration_open',version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${eventId} AND status='draft'`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'evaluation.session.created',
      entityType: 'evaluation_session',
      entityId: id,
    });
    return { id, evaluationEventId: eventId, calendarEventId, ...input };
  });
}

export async function assignEvaluationParticipant(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
  input: ParticipantInput,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const event = await eventRow(trx, context.orgId, eventId);
    if (!event)
      throw new EvaluationError(404, 'NOT_FOUND', 'Evaluation event not found');
    if (!['draft', 'registration_open'].includes(event.status))
      throw new EvaluationError(
        409,
        'EVENT_LOCKED',
        'New participants cannot be added after scoring starts',
      );
    const person = await sql<{
      id: string;
      first_name: string;
      last_name: string;
      date_of_birth: Date | string;
      competition_gender: string | null;
      media_consent: string;
      photo_file_id: string | null;
      school_name: string | null;
    }>`
        SELECT id,first_name,last_name,date_of_birth,competition_gender,media_consent,photo_file_id,school_name
        FROM people WHERE org_id=${context.orgId} AND id=${input.personId} AND status='active'`.execute(
      trx,
    );
    if (!person.rows[0])
      throw new EvaluationError(404, 'NOT_FOUND', 'Person not found');
    const groups = await sql<{
      id: string;
      name: string;
      age_min_months: number | null;
      age_max_months: number | null;
      gender: string | null;
      position_keys: string[];
      sort_order: number;
    }>`SELECT id,name,age_min_months,age_max_months,gender,position_keys,sort_order
      FROM evaluation_groups WHERE org_id=${context.orgId} AND evaluation_event_id=${eventId} ORDER BY sort_order`.execute(
      trx,
    );
    const program = await sql<{
      starts_on: Date | string;
    }>`SELECT starts_on FROM programs WHERE org_id=${context.orgId} AND id=${event.tryout_program_id}`.execute(
      trx,
    );
    const firstSession = await sql<{
      local_date: Date | string;
    }>`SELECT starts_at::date AS local_date FROM evaluation_sessions
      WHERE org_id=${context.orgId} AND evaluation_event_id=${eventId} ORDER BY starts_at LIMIT 1`.execute(
      trx,
    );
    const eventDate = firstSession.rows[0]
      ? dateOnly(firstSession.rows[0].local_date)
      : dateOnly(
          program.rows[0]?.starts_on ?? dependencies.clock().toISOString(),
        );
    const ageMonths = Temporal.PlainDate.from(
      dateOnly(person.rows[0].date_of_birth),
    ).until(Temporal.PlainDate.from(eventDate), {
      largestUnit: 'months',
    }).months;
    const matches = groups.rows.filter(
      (candidate) =>
        (candidate.age_min_months === null ||
          ageMonths >= candidate.age_min_months) &&
        (candidate.age_max_months === null ||
          ageMonths <= candidate.age_max_months) &&
        (!candidate.gender ||
          candidate.gender === 'open' ||
          candidate.gender === person.rows[0]?.competition_gender) &&
        (!candidate.position_keys.length ||
          input.positionKeys.some((position) =>
            candidate.position_keys.includes(position),
          )),
    );
    const selectedGroup = input.groupId
      ? groups.rows.find((candidate) => candidate.id === input.groupId)
      : matches[0];
    if (
      !selectedGroup ||
      !matches.some((candidate) => candidate.id === selectedGroup.id)
    )
      throw new EvaluationError(
        422,
        'GROUP_NOT_ELIGIBLE',
        'No evaluation group matches the athlete age, gender and positions',
      );
    await sql`SELECT id FROM evaluation_groups WHERE org_id=${context.orgId} AND id=${selectedGroup.id} FOR UPDATE`.execute(
      trx,
    );
    if (input.registrationId) {
      const registration = await sql<{
        id: string;
      }>`SELECT id FROM registrations WHERE org_id=${context.orgId}
        AND id=${input.registrationId} AND person_id=${input.personId} AND program_id=${event.tryout_program_id}
        AND status='confirmed'`.execute(trx);
      if (!registration.rows[0])
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Tryout registration not found',
        );
    }
    if (input.sessionId) {
      const session = await sql<{
        id: string;
        group_id: string | null;
        capacity: number | null;
      }>`SELECT id,evaluation_group_id AS group_id,capacity FROM evaluation_sessions
        WHERE org_id=${context.orgId} AND id=${input.sessionId} AND evaluation_event_id=${eventId} FOR UPDATE`.execute(
        trx,
      );
      if (
        !session.rows[0] ||
        (session.rows[0].group_id &&
          session.rows[0].group_id !== selectedGroup.id)
      )
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Evaluation session not found for this group',
        );
      const selectedSession = session.rows[0];
      if (selectedSession.capacity !== null) {
        const enrolled = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count
          FROM evaluation_participants WHERE org_id=${context.orgId} AND evaluation_session_id=${input.sessionId}
            AND check_in_status <> 'withdrawn'`.execute(trx);
        if ((enrolled.rows[0]?.count ?? 0) >= selectedSession.capacity)
          throw new EvaluationError(
            409,
            'CAPACITY_EXCEEDED',
            'Evaluation session has reached its capacity',
          );
      }
    }
    const mediaConsent = person.rows[0].media_consent === 'granted';
    let photoFileId: string | null = null;
    if (mediaConsent && person.rows[0].photo_file_id) {
      const file = await sql<{
        id: string;
      }>`SELECT id FROM files WHERE org_id=${context.orgId}
        AND id=${person.rows[0].photo_file_id} AND owner_type='person' AND owner_id=${input.personId}
        AND purpose='image' AND upload_state='complete' AND deleted_at IS NULL`.execute(
        trx,
      );
      if (file.rows[0]) photoFileId = file.rows[0].id;
    }
    const bib = await sql<{
      next_bib: number;
    }>`SELECT COALESCE(MAX(bib_number),0)+1 AS next_bib FROM evaluation_participants
      WHERE org_id=${context.orgId} AND evaluation_event_id=${eventId} AND evaluation_group_id=${selectedGroup.id}`.execute(
      trx,
    );
    const id = randomUUID();
    await sql`INSERT INTO evaluation_participants
      (id,org_id,evaluation_event_id,person_id,evaluation_group_id,evaluation_session_id,registration_id,bib_number,media_consent,photo_file_id,position_keys)
      VALUES (${id},${context.orgId},${eventId},${input.personId},${selectedGroup.id},${input.sessionId},${input.registrationId},${bib.rows[0]?.next_bib ?? 1},${Boolean(photoFileId)},${photoFileId},${input.positionKeys})`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'evaluation.participant.assigned',
      entityType: 'evaluation_participant',
      entityId: id,
    });
    return {
      id,
      personId: input.personId,
      groupId: selectedGroup.id,
      sessionId: input.sessionId,
      bibNumber: bib.rows[0]?.next_bib ?? 1,
      firstName: person.rows[0].first_name,
      lastName: person.rows[0].last_name,
      photoFileId,
      mediaConsent: Boolean(photoFileId),
      checkInStatus: 'expected',
    };
  });
}

export async function checkInEvaluationParticipant(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  participantId: string,
  late = false,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const existing = await sql<{
      id: string;
      version: number;
      check_in_status: string;
    }>`SELECT id,version,check_in_status FROM evaluation_participants
      WHERE org_id=${context.orgId} AND id=${participantId} FOR UPDATE`.execute(
      trx,
    );
    const participant = existing.rows[0];
    if (!participant)
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Evaluation participant not found',
      );
    if (participant.check_in_status !== 'expected') return participant;
    const result = await sql<{
      id: string;
      version: number;
      check_in_status: string;
    }>`UPDATE evaluation_participants
      SET check_in_status=${late ? 'late' : 'checked_in'},checked_in_at=${dependencies.clock()},checked_in_by=${context.actor.accountId},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${participantId}
      RETURNING id,version,check_in_status`.execute(trx);
    await appendAuditEvent(trx, context, {
      action: 'evaluation.participant.checked_in',
      entityType: 'evaluation_participant',
      entityId: participantId,
    });
    return result.rows[0] ?? participant;
  });
}

export async function assignEvaluationEvaluator(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  sessionId: string,
  accountId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  const evaluator = await withOrg(context, async (trx) => {
    const session = await sql<{
      event_id: string;
      target_program_id: string;
    }>`SELECT s.evaluation_event_id AS event_id,e.target_program_id FROM evaluation_sessions s
      JOIN evaluation_events e ON e.org_id=s.org_id AND e.id=s.evaluation_event_id
      WHERE s.org_id=${context.orgId} AND s.id=${sessionId}`.execute(trx);
    if (!session.rows[0])
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Evaluation session not found',
      );
    const person = await sql<{
      person_id: string;
    }>`SELECT person_id FROM person_account_links
      WHERE org_id=${context.orgId} AND account_id=${accountId} AND relationship='self' AND revoked_at IS NULL`.execute(
      trx,
    );
    if (!person.rows[0])
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Evaluator person record not found',
      );
    return {
      personId: person.rows[0].person_id,
      targetProgramId: session.rows[0].target_program_id,
    };
  });
  // This wrapper uses the shared compliance gate and its owner-only, reasoned override rules.
  const serviceModule = await import('../compliance/policy');
  try {
    await serviceModule.assertEligibleForRole(
      dependencies.database,
      context,
      {
        personId: evaluator.personId,
        role: 'evaluator',
        programId: evaluator.targetProgramId,
        onDate: dependencies.clock().toISOString().slice(0, 10),
      },
      dependencies.clock(),
    );
  } catch (error) {
    if (error instanceof serviceModule.RoleEligibilityError)
      throw new EvaluationError(
        409,
        'COMPLIANCE_REQUIRED',
        'Evaluator does not meet current safety requirements',
      );
    throw error;
  }
  return withOrg(context, async (trx) => {
    const existing = await sql<{
      id: string;
    }>`SELECT id FROM evaluation_session_evaluators
      WHERE org_id=${context.orgId} AND evaluation_session_id=${sessionId} AND account_id=${accountId}`.execute(
      trx,
    );
    const id = existing.rows[0]?.id ?? randomUUID();
    await sql`INSERT INTO evaluation_session_evaluators
      (id,org_id,evaluation_session_id,account_id,assigned_by,revoked_at)
      VALUES (${id},${context.orgId},${sessionId},${accountId},${context.actor.accountId},NULL)
      ON CONFLICT (org_id,evaluation_session_id,account_id) DO UPDATE SET revoked_at=NULL,assigned_by=EXCLUDED.assigned_by,version=evaluation_session_evaluators.version+1,updated_at=now()`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'evaluation.evaluator.assigned',
      entityType: 'evaluation_session_evaluator',
      entityId: id,
    });
    return { id, sessionId, accountId };
  });
}

export async function listEvaluationScoringSheet(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
  evaluatorAccountId: string,
  mayViewAll: boolean,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const event = await eventRow(trx, context.orgId, eventId);
    if (!event)
      throw new EvaluationError(404, 'NOT_FOUND', 'Evaluation event not found');
    if (!mayViewAll) {
      const assigned = await sql<{
        id: string;
      }>`SELECT 1 AS id FROM evaluation_session_evaluators se
        JOIN evaluation_sessions s ON s.org_id=se.org_id AND s.id=se.evaluation_session_id
        WHERE se.org_id=${context.orgId} AND se.account_id=${evaluatorAccountId} AND se.revoked_at IS NULL
          AND s.evaluation_event_id=${eventId}`.execute(trx);
      if (!assigned.rows.length)
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Evaluation assignment not found',
        );
    }
    const [participants, criteria] = await Promise.all([
      sql<
        Record<string, unknown>
      >`SELECT p.id,p.person_id,p.bib_number,p.evaluation_group_id AS group_id,
          g.name AS group_name,p.position_keys,p.check_in_status,
          pe.first_name,pe.last_name,
          CASE WHEN pe.media_consent='granted' AND p.media_consent THEN p.photo_file_id ELSE NULL END AS photo_file_id
        FROM evaluation_participants p
        JOIN evaluation_groups g ON g.org_id=p.org_id AND g.id=p.evaluation_group_id
        JOIN people pe ON pe.org_id=p.org_id AND pe.id=p.person_id
        WHERE p.org_id=${context.orgId} AND p.evaluation_event_id=${eventId}
          AND (${mayViewAll} OR p.evaluation_session_id IN (
            SELECT evaluation_session_id FROM evaluation_session_evaluators WHERE org_id=${context.orgId} AND account_id=${evaluatorAccountId} AND revoked_at IS NULL
          ))
        ORDER BY g.sort_order,p.bib_number`.execute(trx),
      sql<
        Record<string, unknown>
      >`SELECT id,criterion_key AS key,label,weight::float8,scale_min::float8 AS "scaleMin",scale_max::float8 AS "scaleMax",
          position_specific AS "positionSpecific",position_keys AS "positionKeys",sort_order
        FROM evaluation_criteria WHERE org_id=${context.orgId} AND evaluation_event_id=${eventId} ORDER BY sort_order`.execute(
        trx,
      ),
    ]);
    const ownScores = await sql<
      Record<string, unknown>
    >`SELECT evaluation_participant_id AS "participantId",evaluation_criterion_id AS "criterionId",
        score,notes,client_mutation_id AS "clientMutationId",version
      FROM evaluation_scores WHERE org_id=${context.orgId} AND evaluation_event_id=${eventId}
        AND evaluator_account_id=${evaluatorAccountId}`.execute(trx);
    return {
      event: {
        id: event.id,
        name: event.name,
        normalization: event.normalization,
        status: event.status,
      },
      participants: participants.rows.map((row) => ({
        id: String(row.id),
        personId: String(row.person_id),
        bibNumber: Number(row.bib_number),
        groupId: String(row.group_id),
        groupName: String(row.group_name),
        positionKeys: row.position_keys as string[],
        checkInStatus: String(row.check_in_status),
        firstName: String(row.first_name),
        lastName: String(row.last_name),
        photoFileId: (row.photo_file_id as string | null) ?? null,
      })),
      criteria: criteria.rows,
      scores: ownScores.rows.map((row) => ({
        ...row,
        score: Number(row.score),
      })),
    };
  });
}

export async function upsertEvaluationScore(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
  evaluatorAccountId: string,
  input: ScoreInput,
  mayScoreAll: boolean,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const [event, source] = await Promise.all([
      eventRow(trx, context.orgId, eventId),
      sql<{
        participant_id: string;
        session_id: string | null;
        criterion_id: string;
        criterion_key: string;
        scale_min: number;
        scale_max: number;
      }>`
        SELECT p.id AS participant_id,p.evaluation_session_id AS session_id,c.id AS criterion_id,c.criterion_key,
          c.scale_min::float8,c.scale_max::float8
        FROM evaluation_participants p JOIN evaluation_criteria c ON c.org_id=p.org_id AND c.evaluation_event_id=p.evaluation_event_id
        WHERE p.org_id=${context.orgId} AND p.evaluation_event_id=${eventId}
          AND p.id=${input.participantId} AND c.id=${input.criterionId}`.execute(
        trx,
      ),
    ]);
    const target = source.rows[0];
    if (!event || !target)
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Evaluation record not found',
      );
    if (!['registration_open', 'scoring'].includes(event.status))
      throw new EvaluationError(409, 'EVENT_LOCKED', 'Scoring is not open');
    if (input.score < target.scale_min || input.score > target.scale_max)
      throw new EvaluationError(
        422,
        'INVALID_SCORE',
        'Score is outside the criterion scale',
      );
    if (!mayScoreAll) {
      const assigned = await sql<{
        id: string;
      }>`SELECT id FROM evaluation_session_evaluators
        WHERE org_id=${context.orgId} AND evaluation_session_id=${target.session_id}
          AND account_id=${evaluatorAccountId} AND revoked_at IS NULL`.execute(
        trx,
      );
      if (!target.session_id || !assigned.rows[0])
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Evaluation assignment not found',
        );
    }
    const scoreId = randomUUID();
    const upsert = await sql<{
      id: string;
      version: number;
      client_mutation_id: string;
    }>`
      INSERT INTO evaluation_scores
        (id,org_id,evaluation_event_id,evaluation_participant_id,evaluation_criterion_id,evaluator_account_id,score,notes,client_mutation_id)
      VALUES (${scoreId},${context.orgId},${eventId},${input.participantId},${input.criterionId},${evaluatorAccountId},${input.score},${input.notes},${input.clientMutationId})
      ON CONFLICT (org_id,evaluation_participant_id,evaluation_criterion_id,evaluator_account_id)
      DO UPDATE SET score=EXCLUDED.score,notes=EXCLUDED.notes,client_mutation_id=EXCLUDED.client_mutation_id,
        scored_at=now(),version=evaluation_scores.version+1,updated_at=now()
      RETURNING id,version,client_mutation_id`.execute(trx);
    const row = upsert.rows[0];
    if (!row)
      throw new EvaluationError(
        409,
        'SCORE_CONFLICT',
        'Score could not be saved',
      );
    await sql`UPDATE evaluation_events SET status='scoring',version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${eventId} AND status='registration_open'`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'evaluation.score.saved',
      entityType: 'evaluation_score',
      entityId: row.id,
      changes: {
        score: { tier: 'sensitive', before: '[redacted]', after: '[redacted]' },
      },
    });
    return {
      id: row.id,
      participantId: input.participantId,
      criterionId: input.criterionId,
      version: row.version,
      clientMutationId: row.client_mutation_id,
    };
  });
}

export async function computeEvaluationResults(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const event = await eventRow(trx, context.orgId, eventId);
    if (!event)
      throw new EvaluationError(404, 'NOT_FOUND', 'Evaluation event not found');
    const [criteriaRows, athleteRows, scoreRows] = await Promise.all([
      sql<{
        key: string;
        weight: number;
        scale_min: number;
        scale_max: number;
        position_specific: boolean;
        position_keys: string[];
      }>`SELECT criterion_key AS key,weight::float8 AS weight,scale_min::float8 AS scale_min,scale_max::float8 AS scale_max,position_specific,position_keys
        FROM evaluation_criteria WHERE org_id=${context.orgId} AND evaluation_event_id=${eventId} ORDER BY sort_order`.execute(
        trx,
      ),
      sql<{
        participant_id: string;
        person_id: string;
        group_name: string;
        first_name: string;
        last_name: string;
        positions: string[];
      }>`SELECT p.id AS participant_id,p.person_id,g.name AS group_name,pe.first_name,pe.last_name,p.position_keys AS positions
        FROM evaluation_participants p JOIN evaluation_groups g ON g.org_id=p.org_id AND g.id=p.evaluation_group_id
        JOIN people pe ON pe.org_id=p.org_id AND pe.id=p.person_id
        WHERE p.org_id=${context.orgId} AND p.evaluation_event_id=${eventId}`.execute(
        trx,
      ),
      sql<{
        participant_id: string;
        evaluator_id: string;
        criterion_key: string;
        score: number;
      }>`SELECT s.evaluation_participant_id AS participant_id,s.evaluator_account_id AS evaluator_id,c.criterion_key,s.score::float8 AS score
        FROM evaluation_scores s JOIN evaluation_criteria c ON c.org_id=s.org_id AND c.id=s.evaluation_criterion_id
        WHERE s.org_id=${context.orgId} AND s.evaluation_event_id=${eventId}`.execute(
        trx,
      ),
    ]);
    const criteria: EvaluationCriterion[] = criteriaRows.rows.map((row) => ({
      key: row.key,
      weight: row.weight,
      scaleMin: row.scale_min,
      scaleMax: row.scale_max,
      positionSpecific: row.position_specific,
      positionKeys: row.position_keys,
    }));
    const athletes: EvaluationAthlete[] = athleteRows.rows.map((row) => ({
      id: row.participant_id,
      name: `${row.last_name}, ${row.first_name}`,
      group: row.group_name,
      positions: row.positions,
    }));
    const scores: EvaluationScore[] = scoreRows.rows.map((row) => ({
      athleteId: row.participant_id,
      evaluatorId: row.evaluator_id,
      criterionKey: row.criterion_key,
      score: row.score,
    }));
    const computed = scoreEvaluations({
      criteria,
      athletes,
      scores,
      normalization: event.normalization,
    });
    for (const result of computed) {
      await sql`INSERT INTO evaluation_results
        (id,org_id,evaluation_event_id,evaluation_participant_id,normalized_scores,composite,rank_in_group,evaluator_count,missing_criteria,computed_at)
        VALUES (${randomUUID()},${context.orgId},${eventId},${result.athleteId},${JSON.stringify(result.criterionValues)}::jsonb,${result.composite},${result.rankInGroup},${result.evaluatorCount},${result.missingCriteria},${dependencies.clock()})
        ON CONFLICT (org_id,evaluation_participant_id) DO UPDATE SET normalized_scores=EXCLUDED.normalized_scores,composite=EXCLUDED.composite,
          rank_in_group=EXCLUDED.rank_in_group,evaluator_count=EXCLUDED.evaluator_count,missing_criteria=EXCLUDED.missing_criteria,
          computed_at=EXCLUDED.computed_at,version=evaluation_results.version+1,updated_at=now()`.execute(
        trx,
      );
    }
    await sql`UPDATE evaluation_events SET status='results',version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${eventId}`.execute(trx);
    await appendAuditEvent(trx, context, {
      action: 'evaluation.results.computed',
      entityType: 'evaluation_event',
      entityId: eventId,
      changes: {
        participantCount: { tier: 'internal', after: computed.length },
      },
    });
    return computed.map((item) => ({
      participantId: item.athleteId,
      group: item.group,
      criterionValues: item.criterionValues,
      composite: item.composite,
      rankInGroup: item.rankInGroup,
      evaluatorCount: item.evaluatorCount,
      needsSecondEvaluator: item.needsSecondEvaluator,
      missingCriteria: item.missingCriteria,
    }));
  });
}

export async function createPlacementBoard(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string | null,
  targetProgramId: string,
  input: BoardCreateInput,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const program = await sql<{
      id: string;
      mode: string;
    }>`SELECT id,mode FROM programs WHERE org_id=${context.orgId} AND id=${targetProgramId}`.execute(
      trx,
    );
    if (!program.rows[0])
      throw new EvaluationError(404, 'NOT_FOUND', 'Target program not found');
    if (!eventId && program.rows[0].mode !== 'league')
      throw new EvaluationError(
        422,
        'INVALID_TARGET_PROGRAM',
        'Rec-league boards require a league program',
      );
    if (eventId) {
      const event = await eventRow(trx, context.orgId, eventId);
      if (!event || event.target_program_id !== targetProgramId)
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Evaluation event not found for target program',
        );
      if (event.status !== 'results' && event.status !== 'placement')
        throw new EvaluationError(
          409,
          'RESULTS_REQUIRED',
          'Compute evaluation results before building placements',
        );
    }
    if (input.divisionId) {
      const division = await sql<{
        id: string;
      }>`SELECT id FROM divisions WHERE org_id=${context.orgId} AND id=${input.divisionId} AND program_id=${targetProgramId}`.execute(
        trx,
      );
      if (!division.rows[0])
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Target division not found',
        );
    }
    if (eventId && input.evaluationGroupId) {
      const evaluationGroup = await sql<{
        id: string;
      }>`SELECT id FROM evaluation_groups
        WHERE org_id=${context.orgId} AND id=${input.evaluationGroupId} AND evaluation_event_id=${eventId}`.execute(
        trx,
      );
      if (!evaluationGroup.rows[0])
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Evaluation group not found for this event',
        );
    }
    const id = randomUUID();
    await sql`INSERT INTO placement_boards(id,org_id,evaluation_event_id,target_program_id,division_id,seed,options)
      VALUES (${id},${context.orgId},${eventId},${targetProgramId},${input.divisionId},${input.seed},${JSON.stringify({ siblingsTogether: input.siblingsTogether, returningStay: input.returningStay, evaluationGroupId: input.evaluationGroupId })}::jsonb)`.execute(
      trx,
    );
    const teams = await sql<{
      id: string;
      team_id: string;
      max_roster: number | null;
      name: string;
      preferred_location: string | null;
    }>`SELECT ts.id,ts.team_id,ts.roster_limit AS max_roster,COALESCE(ts.display_name,t.name) AS name,
      ts.practice_preferences->>'location' AS preferred_location
      FROM team_seasons ts JOIN teams t ON t.org_id=ts.org_id AND t.id=ts.team_id
      WHERE ts.org_id=${context.orgId} AND ts.program_id=${targetProgramId} AND ts.status IN ('forming','active')
        AND (${input.divisionId}::uuid IS NULL OR ts.division_id=${input.divisionId}) ORDER BY name,ts.id`.execute(
      trx,
    );
    if (!teams.rows.length)
      throw new EvaluationError(
        409,
        'TEAMS_REQUIRED',
        'Create target team seasons before balancing placements',
      );
    let participants: {
      person_id: string;
      composite: number | null;
      positions: string[];
      school: string | null;
      household_id: string | null;
      group_name: string;
    }[] = [];
    if (eventId) {
      const rows = await sql<{
        person_id: string;
        composite: number | null;
        positions: string[];
        school: string | null;
        household_id: string | null;
        group_name: string;
      }>`SELECT p.person_id,r.composite::float8 AS composite,p.position_keys AS positions,pe.school_name AS school,
          (SELECT hm.household_id FROM household_members hm
           WHERE hm.org_id=p.org_id AND hm.person_id=p.person_id
           ORDER BY hm.is_primary_contact DESC,hm.created_at LIMIT 1) AS household_id,
          g.name AS group_name
        FROM evaluation_participants p JOIN evaluation_groups g ON g.org_id=p.org_id AND g.id=p.evaluation_group_id
        LEFT JOIN evaluation_results r ON r.org_id=p.org_id AND r.evaluation_participant_id=p.id
        JOIN people pe ON pe.org_id=p.org_id AND pe.id=p.person_id
        WHERE p.org_id=${context.orgId} AND p.evaluation_event_id=${eventId}
          AND CASE WHEN ${input.evaluationGroupId}::uuid IS NULL
            THEN (${input.divisionId}::uuid IS NULL OR g.name=(SELECT name FROM divisions WHERE org_id=${context.orgId} AND id=${input.divisionId}))
            ELSE p.evaluation_group_id=${input.evaluationGroupId} END
          AND r.composite IS NOT NULL ORDER BY r.rank_in_group,p.id`.execute(
        trx,
      );
      participants = rows.rows;
    } else {
      const rows = await sql<{
        person_id: string;
        school: string | null;
        household_id: string | null;
        group_name: string;
        coach_rating: number | null;
      }>`SELECT r.person_id,pe.school_name AS school,
        (SELECT hm.household_id FROM household_members hm WHERE hm.org_id=r.org_id AND hm.person_id=r.person_id ORDER BY hm.is_primary_contact DESC LIMIT 1) AS household_id,
        d.name AS group_name,pref.coach_rating::float8 AS coach_rating
        FROM registrations r
        JOIN people pe ON pe.org_id=r.org_id AND pe.id=r.person_id
        JOIN divisions d ON d.org_id=r.org_id AND d.id=r.division_id
        LEFT JOIN placement_preferences pref ON pref.org_id=r.org_id AND pref.program_id=r.program_id AND pref.person_id=r.person_id
        WHERE r.org_id=${context.orgId} AND r.program_id=${targetProgramId}
          AND r.status NOT IN ('canceled','withdrawn','transferred_out')
          AND (${input.divisionId}::uuid IS NULL OR r.division_id=${input.divisionId})
        ORDER BY d.name,pref.coach_rating DESC NULLS LAST,r.created_at`.execute(
        trx,
      );
      participants = rows.rows.map((row) => ({
        person_id: row.person_id,
        composite: row.coach_rating,
        positions: [] as string[],
        school: row.school,
        household_id: row.household_id,
        group_name: row.group_name,
      }));
    }
    if (!participants.length)
      throw new EvaluationError(
        409,
        'PARTICIPANTS_REQUIRED',
        'No ranked participants are available for this board',
      );
    if (
      input.divisionId === null &&
      new Set(participants.map((row) => row.group_name)).size > 1
    )
      throw new EvaluationError(
        422,
        'DIVISION_REQUIRED',
        'Create a separate placement board for each evaluation group',
      );
    const participantIds = new Set(participants.map((row) => row.person_id));
    const preferenceRows = await sql<{
      person_id: string;
      friend_request_person_id: string | null;
      practice_location: string | null;
    }>`SELECT person_id,friend_request_person_id,practice_location
      FROM placement_preferences
      WHERE org_id=${context.orgId} AND program_id=${targetProgramId}`.execute(
      trx,
    );
    const preferenceByPerson = new Map(
      preferenceRows.rows.map((row) => [row.person_id, row]),
    );
    const returningRows = input.returningStay
      ? await sql<{
          person_id: string;
          team_season_id: string;
        }>`SELECT DISTINCT ON (re.person_id) re.person_id,ts_target.id AS team_season_id
        FROM roster_entries re
        JOIN team_seasons ts_prior ON ts_prior.org_id=re.org_id AND ts_prior.id=re.team_season_id AND ts_prior.program_id<>${targetProgramId}
        JOIN programs prior_program ON prior_program.org_id=ts_prior.org_id AND prior_program.id=ts_prior.program_id
        JOIN team_seasons ts_target ON ts_target.org_id=re.org_id AND ts_target.team_id=ts_prior.team_id AND ts_target.program_id=${targetProgramId} AND ts_target.status IN ('forming','active')
        WHERE re.org_id=${context.orgId} AND re.status<>'released'
        ORDER BY re.person_id,prior_program.starts_on DESC NULLS LAST`.execute(
          trx,
        )
      : { rows: [] as { person_id: string; team_season_id: string }[] };
    const returningTeamByPerson = new Map(
      returningRows.rows.map((row) => [row.person_id, row.team_season_id]),
    );
    const fixedRows = await sql<{
      person_id: string;
      team_season_id: string;
    }>`SELECT guardian.person_id,staff.team_season_id
      FROM team_staff staff
      JOIN team_seasons ts ON ts.org_id=staff.org_id AND ts.id=staff.team_season_id AND ts.program_id=${targetProgramId}
      JOIN person_account_links coach ON coach.org_id=staff.org_id AND coach.person_id=staff.person_id AND coach.relationship='self' AND coach.revoked_at IS NULL
      JOIN person_account_links guardian ON guardian.org_id=staff.org_id AND guardian.account_id=coach.account_id AND guardian.relationship='guardian' AND guardian.revoked_at IS NULL
      WHERE staff.org_id=${context.orgId} AND staff.status='active' AND ts.status IN ('forming','active')`.execute(
      trx,
    );
    const fixedTeamByPerson = new Map(
      fixedRows.rows.map((row) => [row.person_id, row.team_season_id]),
    );
    // Tryout boards cut to roster capacity; rec boards must place everyone.
    const defaultCap = Math.ceil(participants.length / teams.rows.length) + 2;
    const totalCapacity = teams.rows.reduce(
      (sum, team) => sum + (team.max_roster ?? defaultCap),
      0,
    );
    if (participants.length > totalCapacity) {
      if (!eventId)
        throw new EvaluationError(
          409,
          'CAPACITY_EXCEEDED',
          'Roster limits cannot hold every registrant; add teams or raise limits',
        );
      participants = participants.slice(0, totalCapacity);
    }
    const householdCounts = new Map<string, number>();
    for (const row of participants)
      if (row.household_id)
        householdCounts.set(
          row.household_id,
          (householdCounts.get(row.household_id) ?? 0) + 1,
        );
    // Normalized composites can be negative; the balancer requires ratings >= 0.
    const ratingFloor = Math.min(
      0,
      ...participants.map((row) => row.composite ?? 0),
    );
    const players = participants.map((row) => {
      const fixedTeamId = fixedTeamByPerson.get(row.person_id);
      const preference = preferenceByPerson.get(row.person_id);
      const friendId = preference?.friend_request_person_id;
      const returningTeamId = returningTeamByPerson.get(row.person_id);
      return {
        id: row.person_id,
        rating: row.composite === null ? null : row.composite - ratingFloor,
        positions: row.positions,
        ...(fixedTeamId ? { fixedTeamId } : {}),
        ...(input.siblingsTogether &&
        row.household_id &&
        (householdCounts.get(row.household_id) ?? 0) > 1
          ? { siblingGroupId: row.household_id }
          : {}),
        ...(row.school ? { school: row.school } : {}),
        ...(friendId && participantIds.has(friendId)
          ? { friendRequestId: friendId }
          : {}),
        ...(input.returningStay && returningTeamId ? { returningTeamId } : {}),
        ...(preference?.practice_location
          ? { location: preference.practice_location }
          : {}),
      };
    });
    const teamInputs = teams.rows.map((team) => ({
      id: team.id,
      maxRoster:
        team.max_roster ?? Math.ceil(players.length / teams.rows.length) + 2,
      ...(Object.keys(input.positionMinimums).length
        ? { minPositions: input.positionMinimums }
        : {}),
      ...(team.preferred_location
        ? { preferredLocation: team.preferred_location }
        : {}),
    }));
    const balanced = balanceTeams({
      players,
      teams: teamInputs,
      siblingsTogether: input.siblingsTogether,
      returningStay: input.returningStay,
      seed: input.seed,
      timeBudgetSeconds: 5,
    });
    for (const row of participants) {
      const teamSeasonId = balanced.assignments[row.person_id];
      if (!teamSeasonId)
        throw new EvaluationError(
          409,
          'BALANCING_FAILED',
          'A participant could not be assigned',
        );
      await sql`INSERT INTO team_placements(id,org_id,placement_board_id,person_id,team_season_id,source,seed_rating)
        VALUES (${randomUUID()},${context.orgId},${id},${row.person_id},${teamSeasonId},${eventId ? 'evaluation' : 'rec_league'},${row.composite})`.execute(
        trx,
      );
    }
    await sql`UPDATE placement_boards SET fairness_metrics=${JSON.stringify(balanced.metrics)}::jsonb,version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${id}`.execute(trx);
    await appendAuditEvent(trx, context, {
      action: 'placement.board.created',
      entityType: 'placement_board',
      entityId: id,
    });
    return {
      id,
      targetProgramId,
      divisionId: input.divisionId,
      seed: input.seed,
      assignments: balanced.assignments,
      metrics: balanced.metrics,
      objective: balanced.objective,
    };
  });
}

export async function movePlacement(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  boardId: string,
  personId: string,
  teamSeasonId: string,
  expectedVersion: number,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const board = await sql<{
      status: string;
      target_program_id: string;
      division_id: string | null;
    }>`SELECT status,target_program_id,division_id FROM placement_boards WHERE org_id=${context.orgId} AND id=${boardId} FOR UPDATE`.execute(
      trx,
    );
    if (!board.rows[0] || board.rows[0].status !== 'draft')
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Draft placement board not found',
      );
    const team = await sql<{
      id: string;
      division_id: string | null;
      roster_limit: number | null;
    }>`SELECT id,division_id,roster_limit FROM team_seasons WHERE org_id=${context.orgId} AND id=${teamSeasonId} AND program_id=${board.rows[0].target_program_id} AND status IN ('forming','active')`.execute(
      trx,
    );
    const placement = await sql<{
      id: string;
      version: number;
      locked: boolean;
      team_season_id: string;
    }>`SELECT id,version,locked,team_season_id FROM team_placements WHERE org_id=${context.orgId} AND placement_board_id=${boardId} AND person_id=${personId} FOR UPDATE`.execute(
      trx,
    );
    if (!team.rows[0] || !placement.rows[0])
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Placement or team not found',
      );
    if (
      board.rows[0].division_id &&
      team.rows[0].division_id !== board.rows[0].division_id
    )
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Placement team is outside the board division',
      );
    if (
      placement.rows[0].team_season_id !== teamSeasonId &&
      team.rows[0].roster_limit !== null
    ) {
      const roster = await sql<{ count: number }>`SELECT count(*)::int AS count
        FROM team_placements WHERE org_id=${context.orgId} AND placement_board_id=${boardId} AND team_season_id=${teamSeasonId}`.execute(
        trx,
      );
      if ((roster.rows[0]?.count ?? 0) >= team.rows[0].roster_limit)
        throw new EvaluationError(
          409,
          'CAPACITY_EXCEEDED',
          'Target team has reached its roster limit',
        );
    }
    if (placement.rows[0].locked)
      throw new EvaluationError(
        409,
        'PLACEMENT_LOCKED',
        'This placement is locked',
      );
    if (placement.rows[0].version !== expectedVersion)
      throw new EvaluationError(
        409,
        'VERSION_CONFLICT',
        'Placement changed; reload and try again',
      );
    const changed = await sql<{
      id: string;
      version: number;
    }>`UPDATE team_placements SET team_season_id=${teamSeasonId},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${placement.rows[0].id} AND version=${expectedVersion} RETURNING id,version`.execute(
      trx,
    );
    const row = changed.rows[0];
    if (!row)
      throw new EvaluationError(
        409,
        'VERSION_CONFLICT',
        'Placement changed; reload and try again',
      );
    await appendAuditEvent(trx, context, {
      action: 'placement.moved',
      entityType: 'team_placement',
      entityId: row.id,
      changes: { teamSeasonId: { tier: 'internal', after: teamSeasonId } },
    });
    return row;
  });
}

export async function lockPlacement(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  boardId: string,
  personId: string,
  reason: string,
) {
  if (!reason.trim())
    throw new EvaluationError(
      422,
      'REASON_REQUIRED',
      'A reason is required for a placement lock',
    );
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const board = await sql<{
      status: string;
    }>`SELECT status FROM placement_boards
      WHERE org_id=${context.orgId} AND id=${boardId} FOR UPDATE`.execute(trx);
    if (!board.rows[0] || board.rows[0].status !== 'draft')
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Draft placement board not found',
      );
    const row = await sql<{
      id: string;
      team_season_id: string;
    }>`SELECT id,team_season_id FROM team_placements
      WHERE org_id=${context.orgId} AND placement_board_id=${boardId} AND person_id=${personId} FOR UPDATE`.execute(
      trx,
    );
    if (!row.rows[0])
      throw new EvaluationError(404, 'NOT_FOUND', 'Placement not found');
    await sql`UPDATE team_placements SET locked=true,version=version+1,updated_at=now() WHERE org_id=${context.orgId} AND id=${row.rows[0].id}`.execute(
      trx,
    );
    const id = randomUUID();
    await sql`INSERT INTO placement_locks(id,org_id,placement_board_id,person_id,team_season_id,reason,locked_by)
      VALUES (${id},${context.orgId},${boardId},${personId},${row.rows[0].team_season_id},${reason},${context.actor.accountId})
      ON CONFLICT (org_id,placement_board_id,person_id) DO UPDATE SET reason=EXCLUDED.reason,team_season_id=EXCLUDED.team_season_id,locked_by=EXCLUDED.locked_by,released_at=NULL,updated_at=now()`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'placement.locked',
      entityType: 'team_placement',
      entityId: row.rows[0].id,
      changes: { reason: { tier: 'internal', after: reason } },
    });
    return { id, placementId: row.rows[0].id, locked: true };
  });
}

export async function publishPlacementBoard(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  boardId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const board = await sql<{
      id: string;
      status: string;
    }>`UPDATE placement_boards SET status='published',published_at=${dependencies.clock()},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${boardId} AND status='draft' RETURNING id,status`.execute(
      trx,
    );
    if (!board.rows[0])
      throw new EvaluationError(
        409,
        'BOARD_NOT_DRAFT',
        'Draft placement board not found',
      );
    await sql`UPDATE team_placements SET status='published',version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND placement_board_id=${boardId} AND status='draft'`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'placement.board.published',
      entityType: 'placement_board',
      entityId: boardId,
    });
    return board.rows[0];
  });
}

export async function createTeamOffer(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  placementId: string,
  offeringId: string,
  amountCents: number,
  depositCents: number,
  expiresAt: string,
  message: string | null,
) {
  if (depositCents > amountCents)
    throw new EvaluationError(
      422,
      'INVALID_DEPOSIT',
      'Deposit cannot exceed the offering total',
    );
  if (new Date(expiresAt) <= dependencies.clock())
    throw new EvaluationError(
      422,
      'INVALID_EXPIRY',
      'Offer expiry must be in the future',
    );
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const placement = await sql<{
      person_id: string;
      team_season_id: string;
      board_id: string;
      program_id: string;
      household_id: string | null;
      status: string;
    }>`
      SELECT tp.person_id,tp.team_season_id,tp.placement_board_id AS board_id,pb.target_program_id AS program_id,
        (SELECT hm.household_id FROM household_members hm WHERE hm.org_id=tp.org_id AND hm.person_id=tp.person_id ORDER BY hm.is_primary_contact DESC LIMIT 1) AS household_id,tp.status
      FROM team_placements tp JOIN placement_boards pb ON pb.org_id=tp.org_id AND pb.id=tp.placement_board_id
      WHERE tp.org_id=${context.orgId} AND tp.id=${placementId}`.execute(trx);
    const row = placement.rows[0];
    if (!row || !row.household_id || row.status !== 'published')
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Published placement not found',
      );
    const offering = await sql<{
      id: string;
      price_cents: number;
    }>`SELECT id,price_cents::float8 AS price_cents FROM registration_offerings WHERE org_id=${context.orgId}
      AND id=${offeringId} AND program_id=${row.program_id} AND active=true`.execute(
      trx,
    );
    if (!offering.rows[0])
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Registration offering not found',
      );
    if (
      !Number.isSafeInteger(amountCents) ||
      offering.rows[0].price_cents !== amountCents
    )
      throw new EvaluationError(
        422,
        'OFFER_AMOUNT_MISMATCH',
        'Offer amount must match the selected registration offering',
      );
    const id = randomUUID();
    await sql`INSERT INTO team_offers(id,org_id,placement_id,person_id,household_id,offering_id,team_season_id,amount_cents,deposit_cents,expires_at,message)
      VALUES (${id},${context.orgId},${placementId},${row.person_id},${row.household_id},${offeringId},${row.team_season_id},${amountCents},${depositCents},${expiresAt},${message})`.execute(
      trx,
    );
    await sql`UPDATE team_placements SET status='offer_sent',version=version+1,updated_at=now() WHERE org_id=${context.orgId} AND id=${placementId}`.execute(
      trx,
    );
    for (const accountId of await householdRecipientIds(
      trx,
      context.orgId,
      row.household_id,
    ))
      await createNotification(trx, context, {
        accountId,
        type: 'evaluation.offer',
        payload: {
          resourceType: 'team_offer',
          resourceId: id,
          personId: row.person_id,
          href: `/portal/orgs/${context.orgId}/offers`,
        },
      });
    await appendAuditEvent(trx, context, {
      action: 'placement.offer.created',
      entityType: 'team_offer',
      entityId: id,
    });
    return {
      id,
      placementId,
      personId: row.person_id,
      householdId: row.household_id,
      amountCents,
      depositCents,
      expiresAt,
      status: 'sent',
    };
  });
}

export async function declineTeamOffer(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  offerId: string,
  reason: string,
  expectedVersion: number,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const updated = await sql<{
      id: string;
      placement_id: string;
      version: number;
    }>`UPDATE team_offers SET status='declined',decline_reason=${reason},declined_by_account_id=${context.actor.accountId},responded_at=${dependencies.clock()},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${offerId} AND status='sent' AND version=${expectedVersion}
        AND household_id IN (SELECT hm.household_id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
          WHERE hm.org_id=${context.orgId} AND pal.account_id=${context.actor.accountId} AND pal.relationship='guardian' AND pal.revoked_at IS NULL)
      RETURNING id,placement_id,version`.execute(trx);
    const row = updated.rows[0];
    if (!row)
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Offer not found or unavailable',
      );
    await sql`UPDATE team_placements SET status='declined',version=version+1,updated_at=now() WHERE org_id=${context.orgId} AND id=${row.placement_id}`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'placement.offer.declined',
      entityType: 'team_offer',
      entityId: row.id,
      changes: { reason: { tier: 'internal', after: reason } },
    });
    return row;
  });
}

export async function acceptTeamOffer(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  offerId: string,
  checkout: OfferCheckoutAdapter,
) {
  const withOrg = createWithOrg(dependencies.database);
  const offer = await withOrg(context, async (trx) => {
    const row = await sql<{
      id: string;
      person_id: string;
      household_id: string;
      offering_id: string;
      team_season_id: string;
      amount_cents: number;
      deposit_cents: number;
      expires_at: Date | string;
      status: string;
      version: number;
      checkout_id: string | null;
      registration_id: string | null;
    }>`SELECT id,person_id,household_id,offering_id,team_season_id,amount_cents,deposit_cents,expires_at,status,version,checkout_id,registration_id
      FROM team_offers WHERE org_id=${context.orgId} AND id=${offerId} FOR UPDATE`.execute(
      trx,
    );
    const item = row.rows[0];
    if (
      !item ||
      !['sent', 'accepting', 'accepted'].includes(item.status) ||
      (item.status !== 'accepted' &&
        new Date(item.expires_at) <= dependencies.clock())
    )
      throw new EvaluationError(404, 'NOT_FOUND', 'Offer not found or expired');
    const guardian = await sql<{
      id: string;
    }>`SELECT hm.id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
      WHERE hm.org_id=${context.orgId} AND hm.household_id=${item.household_id} AND pal.account_id=${context.actor.accountId}
        AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL`.execute(
      trx,
    );
    if (!guardian.rows[0])
      throw new EvaluationError(404, 'NOT_FOUND', 'Offer not found or expired');
    if (item.status === 'sent') {
      await sql`UPDATE team_offers SET status='accepting',version=version+1,updated_at=now()
        WHERE org_id=${context.orgId} AND id=${offerId} AND status='sent'`.execute(
        trx,
      );
    }
    return item;
  });
  if (offer.status === 'accepted' && offer.checkout_id && offer.registration_id)
    return {
      offerId,
      status: 'accepted',
      registrationId: offer.registration_id,
      checkoutId: offer.checkout_id,
    };
  const accepted = await checkout.accept({
    orgId: context.orgId,
    offerId,
    accountId: context.actor.accountId,
    householdId: offer.household_id,
    personId: offer.person_id,
    offeringId: offer.offering_id,
    teamSeasonId: offer.team_season_id,
    amountCents: offer.amount_cents,
    depositCents: offer.deposit_cents,
    idempotencyKey: offerId,
  });
  await withOrg(context, async (trx) => {
    const result = await sql<{
      id: string;
    }>`UPDATE team_offers SET status='accepted',responded_at=${dependencies.clock()},registration_id=${accepted.registrationId},checkout_id=${accepted.checkoutId},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${offerId} AND status='accepting'
      RETURNING id`.execute(trx);
    if (!result.rows[0])
      throw new EvaluationError(
        409,
        'OFFER_RACE',
        'Offer status changed during checkout',
      );
    await sql`UPDATE team_placements SET status='accepted',version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=(SELECT placement_id FROM team_offers WHERE org_id=${context.orgId} AND id=${offerId})`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'placement.offer.accepted',
      entityType: 'team_offer',
      entityId: offerId,
    });
  });
  return { offerId, status: 'accepted', ...accepted };
}

export async function listFamilyOffers(
  dependencies: EvaluationDependencies,
  context: OrgContext,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<{
      id: string;
      personId: string;
      firstName: string;
      lastName: string;
      teamSeasonId: string;
      teamName: string;
      amountCents: number;
      depositCents: number;
      expiresAt: Date;
      message: string | null;
      status: string;
      version: number;
    }>`SELECT offer.id,offer.person_id AS "personId",p.first_name AS "firstName",p.last_name AS "lastName",
      offer.team_season_id AS "teamSeasonId",COALESCE(ts.display_name,t.name) AS "teamName",offer.amount_cents AS "amountCents",
      offer.deposit_cents AS "depositCents",offer.expires_at AS "expiresAt",offer.message,offer.status,offer.version
      FROM team_offers offer JOIN people p ON p.org_id=offer.org_id AND p.id=offer.person_id
      JOIN team_seasons ts ON ts.org_id=offer.org_id AND ts.id=offer.team_season_id JOIN teams t ON t.org_id=ts.org_id AND t.id=ts.team_id
      WHERE offer.org_id=${context.orgId} AND offer.household_id IN (
        SELECT hm.household_id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
        WHERE hm.org_id=${context.orgId} AND pal.account_id=${context.actor.accountId} AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL)
      ORDER BY offer.created_at DESC`.execute(trx);
    return rows.rows;
  });
}

export async function listEvaluationResults(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<{
      participantId: string;
      bibNumber: number;
      group: string;
      firstName: string;
      lastName: string;
      criterionValues: unknown;
      composite: number | null;
      rankInGroup: number | null;
      evaluatorCount: number;
      missingCriteria: string[];
    }>`SELECT p.id AS "participantId",p.bib_number AS "bibNumber",g.name AS "group",
      pe.first_name AS "firstName",pe.last_name AS "lastName",r.normalized_scores AS "criterionValues",r.composite::float8 AS composite,
      r.rank_in_group AS "rankInGroup",r.evaluator_count AS "evaluatorCount",r.missing_criteria AS "missingCriteria"
      FROM evaluation_participants p JOIN people pe ON pe.org_id=p.org_id AND pe.id=p.person_id
      JOIN evaluation_groups g ON g.org_id=p.org_id AND g.id=p.evaluation_group_id
      LEFT JOIN evaluation_results r ON r.org_id=p.org_id AND r.evaluation_participant_id=p.id
      WHERE p.org_id=${context.orgId} AND p.evaluation_event_id=${eventId}
      ORDER BY g.sort_order,r.rank_in_group NULLS LAST,p.bib_number`.execute(
      trx,
    );
    return rows.rows;
  });
}

export async function getPlacementBoard(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  boardId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const board = await sql<{
      id: string;
      target_program_id: string;
      division_id: string | null;
      status: string;
      seed: number;
      fairness_metrics: unknown;
      version: number;
    }>`SELECT id,target_program_id,division_id,status,seed,fairness_metrics,version FROM placement_boards
      WHERE org_id=${context.orgId} AND id=${boardId}`.execute(trx);
    const data = board.rows[0];
    if (!data)
      throw new EvaluationError(404, 'NOT_FOUND', 'Placement board not found');
    const rows = await sql<{
      id: string;
      personId: string;
      firstName: string;
      lastName: string;
      teamSeasonId: string;
      teamName: string;
      rating: number | null;
      locked: boolean;
      status: string;
      version: number;
    }>`SELECT placement.id,placement.person_id AS "personId",p.first_name AS "firstName",p.last_name AS "lastName",
      placement.team_season_id AS "teamSeasonId",COALESCE(ts.display_name,t.name) AS "teamName",placement.seed_rating::float8 AS "rating",
      placement.locked,placement.status,placement.version
      FROM team_placements placement JOIN people p ON p.org_id=placement.org_id AND p.id=placement.person_id
      JOIN team_seasons ts ON ts.org_id=placement.org_id AND ts.id=placement.team_season_id
      JOIN teams t ON t.org_id=ts.org_id AND t.id=ts.team_id
      WHERE placement.org_id=${context.orgId} AND placement.placement_board_id=${boardId}
      ORDER BY "teamName",p.last_name,p.first_name`.execute(trx);
    return {
      id: data.id,
      targetProgramId: data.target_program_id,
      divisionId: data.division_id,
      status: data.status,
      seed: data.seed,
      metrics: data.fairness_metrics,
      version: data.version,
      placements: rows.rows,
    };
  });
}

export async function expireTeamOffers(
  dependencies: EvaluationDependencies,
  context: OrgContext,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const expired = await sql<{
      id: string;
      placement_id: string;
    }>`UPDATE team_offers SET status='expired',responded_at=${dependencies.clock()},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND status='sent' AND expires_at<=${dependencies.clock()}
      RETURNING id,placement_id`.execute(trx);
    for (const row of expired.rows)
      await sql`UPDATE team_placements SET status='declined',version=version+1,updated_at=now()
        WHERE org_id=${context.orgId} AND id=${row.placement_id} AND status='offer_sent'`.execute(
        trx,
      );
    return { expired: expired.rows.length };
  });
}

export async function listEvaluationEvents(
  dependencies: EvaluationDependencies,
  context: OrgContext,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<{
      id: string;
      name: string;
      status: string;
      normalization: string;
      tryoutProgramId: string;
      targetProgramId: string;
      version: number;
      createdAt: Date | string;
      targetProgramName: string;
      participantCount: number;
    }>`SELECT e.id,e.name,e.status,e.normalization,e.tryout_program_id AS "tryoutProgramId",
      e.target_program_id AS "targetProgramId",e.version,e.created_at AS "createdAt",p.name AS "targetProgramName",
      (SELECT count(*)::int FROM evaluation_participants ep WHERE ep.org_id=e.org_id AND ep.evaluation_event_id=e.id) AS "participantCount"
      FROM evaluation_events e JOIN programs p ON p.org_id=e.org_id AND p.id=e.target_program_id
      WHERE e.org_id=${context.orgId} ORDER BY e.created_at DESC`.execute(trx);
    return rows.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
  });
}

export async function listEvaluationPrograms(
  dependencies: EvaluationDependencies,
  context: OrgContext,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const programs = await sql<{
      id: string;
      name: string;
      mode: string;
      sport_profile_id: string;
      sport_profile_name: string;
      profile_rubric: unknown;
    }>`SELECT p.id,p.name,p.mode,p.sport_profile_id,sp.name AS sport_profile_name,
        sp.profile->'evaluationRubric' AS profile_rubric
      FROM programs p JOIN sport_profiles sp ON sp.org_id=p.org_id AND sp.id=p.sport_profile_id
      WHERE p.org_id=${context.orgId} AND p.status <> 'archived'
      ORDER BY p.starts_on DESC,p.name`.execute(trx);
    const divisions = await sql<{
      id: string;
      program_id: string;
      name: string;
    }>`SELECT id,program_id,name FROM divisions WHERE org_id=${context.orgId}
      ORDER BY sort_order,name`.execute(trx);
    const offerings = await sql<{
      id: string;
      program_id: string;
      name: string;
      price_cents: number;
    }>`SELECT id,program_id,name,price_cents::float8 AS price_cents
      FROM registration_offerings WHERE org_id=${context.orgId} AND active=true
      ORDER BY name,id`.execute(trx);
    return programs.rows.map((program) => {
      const parsedRubric = rubricCriterionSchema
        .array()
        .safeParse(program.profile_rubric);
      return {
        id: program.id,
        name: program.name,
        mode: program.mode,
        sportProfileId: program.sport_profile_id,
        sportProfileName: program.sport_profile_name,
        rubric: parsedRubric.success
          ? parsedRubric.data.map((criterion) => ({
              key: criterion.key,
              label: criterion.label.en,
              weight: criterion.weight,
              scaleMin: criterion.scaleMin,
              scaleMax: criterion.scaleMax,
              positionSpecific: criterion.positionSpecific ?? false,
              positionKeys: criterion.positionKeys ?? [],
            }))
          : [],
        divisions: divisions.rows
          .filter((division) => division.program_id === program.id)
          .map((division) => ({ id: division.id, name: division.name })),
        offerings: offerings.rows
          .filter((offering) => offering.program_id === program.id)
          .map((offering) => ({
            id: offering.id,
            name: offering.name,
            priceCents: offering.price_cents,
          })),
      };
    });
  });
}

export async function listEvaluationEvaluatorCandidates(
  dependencies: EvaluationDependencies,
  context: OrgContext,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<
      Record<string, unknown>
    >`SELECT DISTINCT account.id AS "accountId",account.first_name AS "firstName",account.last_name AS "lastName"
      FROM role_assignments role
      JOIN org_memberships membership ON membership.org_id=role.org_id AND membership.account_id=role.account_id
      JOIN accounts account ON account.id=role.account_id
      JOIN person_account_links link ON link.org_id=role.org_id AND link.account_id=role.account_id AND link.relationship='self' AND link.revoked_at IS NULL
      WHERE role.org_id=${context.orgId} AND role.role='evaluator' AND role.scope_type='org'
        AND role.pending_mfa=false AND role.revoked_at IS NULL AND membership.status='active'
      ORDER BY account.last_name,account.first_name,account.id`.execute(trx);
    return rows.rows;
  });
}

export async function listEvaluationRegistrants(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const event = await eventRow(trx, context.orgId, eventId);
    if (!event)
      throw new EvaluationError(404, 'NOT_FOUND', 'Evaluation event not found');
    const rows = await sql<{
      registrationId: string;
      personId: string;
      firstName: string;
      lastName: string;
      assigned: boolean;
    }>`SELECT r.id AS "registrationId",p.id AS "personId",p.first_name AS "firstName",
        p.last_name AS "lastName",
        EXISTS (SELECT 1 FROM evaluation_participants ep WHERE ep.org_id=r.org_id
          AND ep.evaluation_event_id=${eventId} AND ep.person_id=r.person_id) AS assigned
      FROM registrations r JOIN people p ON p.org_id=r.org_id AND p.id=r.person_id
      WHERE r.org_id=${context.orgId} AND r.program_id=${event.tryout_program_id}
        AND r.status='confirmed'
      ORDER BY p.last_name,p.first_name,r.created_at,r.id`.execute(trx);
    return rows.rows;
  });
}

export async function getEvaluationSetup(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const event = await eventRow(trx, context.orgId, eventId);
    if (!event)
      throw new EvaluationError(404, 'NOT_FOUND', 'Evaluation event not found');
    const [groups, sessions, participants] = await Promise.all([
      sql<
        Record<string, unknown>
      >`SELECT id,name,age_min_months AS "ageMinMonths",age_max_months AS "ageMaxMonths",gender,position_keys AS "positionKeys",sort_order AS "sortOrder"
        FROM evaluation_groups WHERE org_id=${context.orgId} AND evaluation_event_id=${eventId} ORDER BY sort_order`.execute(
        trx,
      ),
      sql<
        Record<string, unknown>
      >`SELECT id,evaluation_group_id AS "groupId",calendar_event_id AS "calendarEventId",name,starts_at AS "startsAt",ends_at AS "endsAt",timezone,facility_id AS "facilityId",capacity,version
        FROM evaluation_sessions WHERE org_id=${context.orgId} AND evaluation_event_id=${eventId} ORDER BY starts_at`.execute(
        trx,
      ),
      sql<
        Record<string, unknown>
      >`SELECT p.id,p.person_id AS "personId",p.registration_id AS "registrationId",p.evaluation_group_id AS "groupId",g.name AS "groupName",p.evaluation_session_id AS "sessionId",p.bib_number AS "bibNumber",p.check_in_status AS "checkInStatus",pe.first_name AS "firstName",pe.last_name AS "lastName"
        FROM evaluation_participants p JOIN evaluation_groups g ON g.org_id=p.org_id AND g.id=p.evaluation_group_id JOIN people pe ON pe.org_id=p.org_id AND pe.id=p.person_id
        WHERE p.org_id=${context.orgId} AND p.evaluation_event_id=${eventId} ORDER BY g.sort_order,p.bib_number`.execute(
        trx,
      ),
    ]);
    return {
      event,
      groups: groups.rows,
      sessions: sessions.rows,
      participants: participants.rows,
    };
  });
}

export async function evaluationConsistency(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  eventId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<
      Record<string, unknown>
    >`SELECT s.evaluator_account_id AS "evaluatorId",
      trim(concat_ws(' ',evaluator.first_name,evaluator.last_name)) AS "evaluatorName",
      c.criterion_key AS "criterionKey",
      count(*)::int AS "scoreCount",avg(s.score)::float8 AS mean,stddev_pop(s.score)::float8 AS standard_deviation
      FROM evaluation_scores s JOIN evaluation_criteria c ON c.org_id=s.org_id AND c.id=s.evaluation_criterion_id
      JOIN accounts evaluator ON evaluator.id=s.evaluator_account_id
      WHERE s.org_id=${context.orgId} AND s.evaluation_event_id=${eventId}
      GROUP BY s.evaluator_account_id,evaluator.first_name,evaluator.last_name,c.criterion_key ORDER BY evaluator.last_name,evaluator.first_name,c.criterion_key`.execute(
      trx,
    );
    return rows.rows;
  });
}

async function householdRecipientIds(
  trx: OrgTransaction,
  orgId: string,
  householdId: string,
): Promise<string[]> {
  const rows = await sql<{
    account_id: string;
  }>`SELECT DISTINCT pal.account_id FROM household_members hm
    JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
    WHERE hm.org_id=${orgId} AND hm.household_id=${householdId}
      AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL`.execute(
    trx,
  );
  return rows.rows.map((row) => row.account_id);
}

export async function upsertPlacementPreference(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  programId: string,
  input: PlacementPreferenceInput,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const program = await sql<{
      id: string;
    }>`SELECT id FROM programs WHERE org_id=${context.orgId} AND id=${programId}`.execute(
      trx,
    );
    if (!program.rows[0])
      throw new EvaluationError(404, 'NOT_FOUND', 'Program not found');
    const people = await sql<{
      id: string;
    }>`SELECT id FROM people WHERE org_id=${context.orgId} AND id IN (${sql.join(
      [input.personId, input.friendRequestPersonId]
        .filter((value): value is string => Boolean(value))
        .map((value) => sql`${value}::uuid`),
    )})`.execute(trx);
    const known = new Set(people.rows.map((row) => row.id));
    if (!known.has(input.personId))
      throw new EvaluationError(404, 'NOT_FOUND', 'Person not found');
    if (input.friendRequestPersonId && !known.has(input.friendRequestPersonId))
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Friend request person not found',
      );
    const id = randomUUID();
    const saved = await sql<{
      id: string;
      version: number;
    }>`INSERT INTO placement_preferences
      (id,org_id,program_id,person_id,friend_request_person_id,practice_location,coach_rating,note,source)
      VALUES (${id},${context.orgId},${programId},${input.personId},${input.friendRequestPersonId},${input.practiceLocation},${input.coachRating},${input.note},${input.source})
      ON CONFLICT (org_id,program_id,person_id) DO UPDATE SET
        friend_request_person_id=EXCLUDED.friend_request_person_id,
        practice_location=EXCLUDED.practice_location,
        coach_rating=CASE WHEN EXCLUDED.source='family' THEN placement_preferences.coach_rating ELSE EXCLUDED.coach_rating END,
        note=EXCLUDED.note,source=EXCLUDED.source,
        version=placement_preferences.version+1,updated_at=now()
      RETURNING id,version`.execute(trx);
    const row = saved.rows[0];
    if (!row)
      throw new EvaluationError(
        409,
        'PREFERENCE_CONFLICT',
        'Placement preference could not be saved',
      );
    await appendAuditEvent(trx, context, {
      action: 'placement.preference.saved',
      entityType: 'placement_preference',
      entityId: row.id,
    });
    return {
      id: row.id,
      programId,
      personId: input.personId,
      version: row.version,
    };
  });
}

export async function listPlacementPreferences(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  programId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<{
      personId: string;
      firstName: string;
      lastName: string;
      friendRequestPersonId: string | null;
      friendFirstName: string | null;
      friendLastName: string | null;
      practiceLocation: string | null;
      coachRating: number | null;
      note: string | null;
      source: string;
      version: number;
    }>`SELECT pref.person_id AS "personId",p.first_name AS "firstName",p.last_name AS "lastName",
      pref.friend_request_person_id AS "friendRequestPersonId",friend.first_name AS "friendFirstName",friend.last_name AS "friendLastName",
      pref.practice_location AS "practiceLocation",pref.coach_rating::float8 AS "coachRating",pref.note,pref.source,pref.version
      FROM placement_preferences pref
      JOIN people p ON p.org_id=pref.org_id AND p.id=pref.person_id
      LEFT JOIN people friend ON friend.org_id=pref.org_id AND friend.id=pref.friend_request_person_id
      WHERE pref.org_id=${context.orgId} AND pref.program_id=${programId}
      ORDER BY p.last_name,p.first_name`.execute(trx);
    return rows.rows;
  });
}

export async function listMyPlacementPrograms(
  dependencies: EvaluationDependencies,
  context: OrgContext,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<
      Record<string, unknown>
    >`SELECT DISTINCT ON (r.program_id,r.person_id)
        r.program_id AS "programId",program.name AS "programName",r.person_id AS "personId",
        person.first_name AS "firstName",person.last_name AS "lastName",r.division_id AS "divisionId",division.name AS "divisionName",
        preference.friend_request_person_id AS "friendRequestPersonId",preference.practice_location AS "practiceLocation"
      FROM registrations r
      JOIN programs program ON program.org_id=r.org_id AND program.id=r.program_id
      JOIN people person ON person.org_id=r.org_id AND person.id=r.person_id
      JOIN divisions division ON division.org_id=r.org_id AND division.id=r.division_id
      JOIN person_account_links link ON link.org_id=r.org_id AND link.person_id=r.person_id
      LEFT JOIN placement_preferences preference ON preference.org_id=r.org_id AND preference.program_id=r.program_id AND preference.person_id=r.person_id
      WHERE r.org_id=${context.orgId} AND link.account_id=${context.actor.accountId}
        AND link.relationship IN ('guardian','self') AND link.revoked_at IS NULL
        AND r.status='confirmed' AND program.mode='league' AND program.status NOT IN ('archived','completed')
      ORDER BY r.program_id,r.person_id,link.verified_at DESC`.execute(trx);
    return rows.rows;
  });
}

export async function upsertMyPlacementPreference(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  programId: string,
  input: Pick<
    PlacementPreferenceInput,
    'personId' | 'friendRequestPersonId' | 'practiceLocation'
  >,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const athlete = await sql<{
      id: string;
    }>`SELECT r.person_id AS id FROM registrations r
      JOIN person_account_links link ON link.org_id=r.org_id AND link.person_id=r.person_id
      JOIN programs program ON program.org_id=r.org_id AND program.id=r.program_id
      WHERE r.org_id=${context.orgId} AND r.program_id=${programId} AND r.person_id=${input.personId}
        AND r.status='confirmed' AND program.mode='league' AND program.status NOT IN ('archived','completed')
        AND link.account_id=${context.actor.accountId} AND link.relationship IN ('guardian','self') AND link.revoked_at IS NULL
      LIMIT 1`.execute(trx);
    if (!athlete.rows[0])
      throw new EvaluationError(
        404,
        'NOT_FOUND',
        'Registered athlete not found',
      );
    if (input.friendRequestPersonId) {
      const friend = await sql<{ id: string }>`SELECT id FROM registrations
        WHERE org_id=${context.orgId} AND program_id=${programId} AND person_id=${input.friendRequestPersonId}
          AND status='confirmed'`.execute(trx);
      if (!friend.rows[0])
        throw new EvaluationError(
          404,
          'NOT_FOUND',
          'Registered friend not found',
        );
    }
    const id = randomUUID();
    const saved = await sql<{
      id: string;
      version: number;
    }>`INSERT INTO placement_preferences
      (id,org_id,program_id,person_id,friend_request_person_id,practice_location,source)
      VALUES (${id},${context.orgId},${programId},${input.personId},${input.friendRequestPersonId},${input.practiceLocation},'family')
      ON CONFLICT (org_id,program_id,person_id) DO UPDATE SET
        friend_request_person_id=EXCLUDED.friend_request_person_id,
        practice_location=EXCLUDED.practice_location,source='family',
        version=placement_preferences.version+1,updated_at=now()
      RETURNING id,version`.execute(trx);
    const row = saved.rows[0];
    if (!row)
      throw new EvaluationError(
        409,
        'PREFERENCE_CONFLICT',
        'Placement preference could not be saved',
      );
    await appendAuditEvent(trx, context, {
      action: 'placement.preference.saved',
      entityType: 'placement_preference',
      entityId: row.id,
    });
    return {
      id: row.id,
      programId,
      personId: input.personId,
      version: row.version,
    };
  });
}

export async function withdrawTeamOffer(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  offerId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const updated = await sql<{
      id: string;
      placement_id: string;
    }>`UPDATE team_offers SET status='withdrawn',responded_at=${dependencies.clock()},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${offerId} AND status='sent'
      RETURNING id,placement_id`.execute(trx);
    const row = updated.rows[0];
    if (!row)
      throw new EvaluationError(404, 'NOT_FOUND', 'Open offer not found');
    await sql`UPDATE team_placements SET status='published',version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${row.placement_id} AND status='offer_sent'`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'placement.offer.withdrawn',
      entityType: 'team_offer',
      entityId: row.id,
    });
    return row;
  });
}

export async function listOfferDashboard(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  boardId: string,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const board = await sql<{
      id: string;
      target_program_id: string;
      division_id: string | null;
      evaluation_event_id: string | null;
      status: string;
    }>`SELECT id,target_program_id,division_id,evaluation_event_id,status FROM placement_boards
      WHERE org_id=${context.orgId} AND id=${boardId}`.execute(trx);
    const data = board.rows[0];
    if (!data)
      throw new EvaluationError(404, 'NOT_FOUND', 'Placement board not found');
    const teams = await sql<{
      teamSeasonId: string;
      teamName: string;
      rosterLimit: number | null;
      sent: number;
      accepted: number;
      declined: number;
      expired: number;
      withdrawn: number;
      placed: number;
    }>`SELECT ts.id AS "teamSeasonId",COALESCE(ts.display_name,t.name) AS "teamName",ts.roster_limit AS "rosterLimit",
      count(offer.id) FILTER (WHERE offer.status='sent' OR offer.status='accepting')::int AS "sent",
      count(offer.id) FILTER (WHERE offer.status='accepted')::int AS "accepted",
      count(offer.id) FILTER (WHERE offer.status='declined')::int AS "declined",
      count(offer.id) FILTER (WHERE offer.status='expired')::int AS "expired",
      count(offer.id) FILTER (WHERE offer.status='withdrawn')::int AS "withdrawn",
      count(placement.id)::int AS "placed"
      FROM team_placements placement
      JOIN team_seasons ts ON ts.org_id=placement.org_id AND ts.id=placement.team_season_id
      JOIN teams t ON t.org_id=ts.org_id AND t.id=ts.team_id
      LEFT JOIN team_offers offer ON offer.org_id=placement.org_id AND offer.placement_id=placement.id
      WHERE placement.org_id=${context.orgId} AND placement.placement_board_id=${boardId}
      GROUP BY ts.id,t.name,ts.display_name,ts.roster_limit
      ORDER BY "teamName"`.execute(trx);
    const suggestions = data.evaluation_event_id
      ? (
          await sql<{
            personId: string;
            firstName: string;
            lastName: string;
            group: string;
            composite: number | null;
            rankInGroup: number | null;
          }>`SELECT p.person_id AS "personId",pe.first_name AS "firstName",pe.last_name AS "lastName",
            g.name AS "group",r.composite::float8 AS composite,r.rank_in_group AS "rankInGroup"
            FROM evaluation_participants p
            JOIN evaluation_groups g ON g.org_id=p.org_id AND g.id=p.evaluation_group_id
            JOIN people pe ON pe.org_id=p.org_id AND pe.id=p.person_id
            JOIN evaluation_results r ON r.org_id=p.org_id AND r.evaluation_participant_id=p.id
            WHERE p.org_id=${context.orgId} AND p.evaluation_event_id=${data.evaluation_event_id}
              AND (${data.division_id}::uuid IS NULL OR g.name=(SELECT name FROM divisions WHERE org_id=${context.orgId} AND id=${data.division_id}))
              AND r.composite IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM team_placements tp WHERE tp.org_id=p.org_id AND tp.placement_board_id=${boardId} AND tp.person_id=p.person_id)
            ORDER BY r.composite DESC NULLS LAST,pe.last_name LIMIT 10`.execute(
            trx,
          )
        ).rows
      : (
          await sql<{
            personId: string;
            firstName: string;
            lastName: string;
            group: string;
            composite: number | null;
            rankInGroup: number | null;
          }>`SELECT r.person_id AS "personId",pe.first_name AS "firstName",pe.last_name AS "lastName",
            d.name AS "group",pref.coach_rating::float8 AS composite, NULL::int AS "rankInGroup"
            FROM registrations r
            JOIN people pe ON pe.org_id=r.org_id AND pe.id=r.person_id
            JOIN divisions d ON d.org_id=r.org_id AND d.id=r.division_id
            LEFT JOIN placement_preferences pref ON pref.org_id=r.org_id AND pref.program_id=r.program_id AND pref.person_id=r.person_id
            WHERE r.org_id=${context.orgId} AND r.program_id=${data.target_program_id}
              AND r.status NOT IN ('canceled','withdrawn','transferred_out')
              AND (${data.division_id}::uuid IS NULL OR r.division_id=${data.division_id})
              AND NOT EXISTS (SELECT 1 FROM team_placements tp WHERE tp.org_id=r.org_id AND tp.placement_board_id=${boardId} AND tp.person_id=r.person_id)
            ORDER BY pref.coach_rating DESC NULLS LAST,pe.last_name LIMIT 10`.execute(
            trx,
          )
        ).rows;
    return {
      boardId,
      status: data.status,
      teams: teams.rows,
      nextInLine: suggestions,
    };
  });
}

export async function sendOfferReminders(
  dependencies: EvaluationDependencies,
  context: OrgContext,
  horizonHours = 48,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const due = await sql<{
      id: string;
      household_id: string;
    }>`UPDATE team_offers SET reminder_sent_at=${dependencies.clock()},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND status='sent' AND reminder_sent_at IS NULL
        AND expires_at>${dependencies.clock()} AND expires_at<=${new Date(dependencies.clock().getTime() + horizonHours * 3_600_000).toISOString()}
      RETURNING id,household_id`.execute(trx);
    for (const row of due.rows) {
      for (const accountId of await householdRecipientIds(
        trx,
        context.orgId,
        row.household_id,
      ))
        await createNotification(trx, context, {
          accountId,
          type: 'offer.expiring',
          payload: {
            resourceType: 'team_offer',
            resourceId: row.id,
            href: `/portal/orgs/${context.orgId}/offers`,
          },
        });
    }
    return { reminded: due.rows.length };
  });
}

export async function processExpiredOffers(
  organizationIds: readonly string[],
  dependencies: EvaluationDependencies,
): Promise<number> {
  let count = 0;
  for (const orgId of organizationIds) {
    const context = {
      orgId,
      actor: { accountId: '0199a1c0-0000-7000-8000-000000000001' },
    };
    await sendOfferReminders(dependencies, context);
    const result = await expireTeamOffers(dependencies, context);
    count += result.expired;
  }
  return count;
}

export async function listMyEvaluationResults(
  dependencies: EvaluationDependencies,
  context: OrgContext,
) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<{
      eventId: string;
      eventName: string;
      participantId: string;
      personId: string;
      firstName: string;
      lastName: string;
      group: string;
      criterionValues: unknown;
      composite: number | null;
      rankInGroup: number | null;
      evaluatorCount: number;
    }>`SELECT e.id AS "eventId",e.name AS "eventName",p.id AS "participantId",pe.id AS "personId",
      pe.first_name AS "firstName",pe.last_name AS "lastName",g.name AS "group",
      r.normalized_scores AS "criterionValues",r.composite::float8 AS composite,r.rank_in_group AS "rankInGroup",
      r.evaluator_count AS "evaluatorCount"
      FROM evaluation_participants p
      JOIN evaluation_events e ON e.org_id=p.org_id AND e.id=p.evaluation_event_id
      JOIN evaluation_groups g ON g.org_id=p.org_id AND g.id=p.evaluation_group_id
      JOIN people pe ON pe.org_id=p.org_id AND pe.id=p.person_id
      LEFT JOIN evaluation_results r ON r.org_id=p.org_id AND r.evaluation_participant_id=p.id
      WHERE p.org_id=${context.orgId} AND e.share_results_with_families
        AND p.person_id IN (
          SELECT pal.person_id FROM person_account_links pal
          WHERE pal.org_id=${context.orgId} AND pal.account_id=${context.actor.accountId}
            AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL)
      ORDER BY e.created_at DESC,g.sort_order,r.rank_in_group NULLS LAST`.execute(
      trx,
    );
    return rows.rows;
  });
}
