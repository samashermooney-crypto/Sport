import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  assignEvaluationEvaluator,
  assignEvaluationParticipant,
  acceptTeamOffer,
  checkInEvaluationParticipant,
  computeEvaluationResults,
  createEvaluationEvent,
  createEvaluationSession,
  createPlacementBoard,
  createTeamOffer,
  declineTeamOffer,
  evaluationConsistency,
  expireTeamOffers,
  getPlacementBoard,
  listEvaluationEvaluatorCandidates,
  listFamilyOffers,
  listMyPlacementPrograms,
  listMyEvaluationResults,
  listOfferDashboard,
  listPlacementPreferences,
  lockPlacement,
  movePlacement,
  publishPlacementBoard,
  sendOfferReminders,
  upsertEvaluationScore,
  upsertPlacementPreference,
  upsertMyPlacementPreference,
  withdrawTeamOffer,
} from './service';
import type { OfferCheckoutAdapter } from './service';

const orgA = randomUUID();
const orgB = randomUUID();
const ownerAccount = randomUUID();
const guardianAccount = randomUUID();
const outsiderAccount = randomUUID();
const evaluatorAccountA = randomUUID();
const evaluatorAccountB = randomUUID();
const evaluatorPersonA = randomUUID();
const evaluatorPersonB = randomUUID();
const guardianPerson = randomUUID();
const seasonId = randomUUID();
const priorSeasonId = randomUUID();
const sportProfileId = randomUUID();
const tryoutProgramId = randomUUID();
const tryoutDivisionId = randomUUID();
const tryoutOfferingId = randomUUID();
const targetProgramId = randomUUID();
const priorProgramId = randomUUID();
const divisionId = randomUUID();
const smallDivisionId = randomUUID();
const smallTeamSeasonId = randomUUID();
const priorDivisionId = randomUUID();
const offeringId = randomUUID();
const householdId = randomUUID();
const householdB = randomUUID();
const childA = randomUUID();
const childB = randomUUID();
const childC = randomUUID();
const childD = randomUUID();
const childE = randomUUID();
const priorTeamId = randomUUID();
const priorTeamSeasonId = randomUUID();
const teamSeasonIds = [randomUUID(), randomUUID(), randomUUID()];

const ownerContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: ownerAccount },
};
const guardianContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: guardianAccount },
};
const outsiderContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: outsiderAccount },
};
const orgBContext: OrgContext = {
  orgId: orgB,
  actor: { accountId: ownerAccount },
};

let clockNow = new Date('2026-09-27T15:00:00.000Z');
let database: Kysely<DB>;
const dependencies = () => ({ database, clock: () => clockNow });

class FakeCheckout implements OfferCheckoutAdapter {
  calls: number = 0;
  constructor(private readonly admin: pg.Client) {}
  async accept(input: {
    orgId: string;
    offerId: string;
    accountId: string;
    householdId: string;
    personId: string;
    offeringId: string;
    teamSeasonId: string;
  }) {
    this.calls += 1;
    const checkoutId = randomUUID();
    const registrationId = randomUUID();
    const invoiceId = randomUUID();
    await this.admin.query(
      `INSERT INTO checkouts (id, org_id, account_id, status, expires_at, items)
       VALUES ($1, $2, $3, 'completed', now() + interval '1 hour', '[]'::jsonb)`,
      [checkoutId, input.orgId, input.accountId],
    );
    await this.admin.query(
      `INSERT INTO registrations (id, org_id, program_id, division_id, offering_id, person_id, household_id, registered_by_account_id, source, status, team_season_id, checkout_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'offer_acceptance', 'confirmed', $9, $10)`,
      [
        registrationId,
        input.orgId,
        targetProgramId,
        divisionId,
        input.offeringId,
        input.personId,
        input.householdId,
        input.accountId,
        input.teamSeasonId,
        checkoutId,
      ],
    );
    await this.admin.query(
      `INSERT INTO invoices (id, org_id, number, account_id, status, currency, source)
       VALUES ($1, $2, 9001, $3, 'open', 'USD', 'checkout')`,
      [invoiceId, input.orgId, input.accountId],
    );
    return {
      registrationId,
      checkoutId,
      invoiceId,
      depositCents: 5000,
      paymentPlanId: null,
    };
  }
}

let admin: pg.Client;
let eventId: string;
let sessionId: string;
let criterionId: string;
let participantA: string;
let participantB: string;
let participantC: string;
let participantD: string;
let participantE: string;
let groupBId: string;
let groupAId: string;
let boardId: string;
let offerId: string;
const tryoutRegistrationIds = new Map<string, string>();

function tryoutRegistrationFor(personId: string): string {
  const registrationId = tryoutRegistrationIds.get(personId);
  if (!registrationId) throw new Error('Missing confirmed tryout registration');
  return registrationId;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const accounts = [
    ownerAccount,
    guardianAccount,
    outsiderAccount,
    evaluatorAccountA,
    evaluatorAccountB,
  ];
  for (const [index, id] of accounts.entries())
    await admin.query(
      `INSERT INTO accounts (id, email, first_name, last_name, date_of_birth)
       VALUES ($1, $2, $3, 'Phase6', '1985-01-01')`,
      [id, `phase6-${String(index)}@example.invalid`, `Acct${String(index)}`],
    );
  await admin.query(
    `INSERT INTO organizations (id, slug, name, kind, timezone, status)
     VALUES ($1, $2, 'Eval Org A', 'club', 'America/Chicago', 'active'),
            ($3, $4, 'Eval Org B', 'club', 'America/Chicago', 'active')`,
    [orgA, `eval-a-${orgA.slice(0, 8)}`, orgB, `eval-b-${orgB.slice(0, 8)}`],
  );
  for (const accountId of accounts)
    await admin.query(
      `INSERT INTO org_memberships (id, org_id, account_id, status, joined_at)
       VALUES ($1, $2, $3, 'active', now())`,
      [randomUUID(), orgA, accountId],
    );
  await admin.query(
    `INSERT INTO role_assignments (id, org_id, account_id, role, scope_type, granted_by, pending_mfa)
     VALUES ($1, $2, $3, 'owner', 'org', $3, false)`,
    [randomUUID(), orgA, ownerAccount],
  );
  for (const accountId of [evaluatorAccountA, evaluatorAccountB])
    await admin.query(
      `INSERT INTO role_assignments (id, org_id, account_id, role, scope_type, granted_by, pending_mfa)
       VALUES ($1, $2, $3, 'evaluator', 'org', $4, false)`,
      [randomUUID(), orgA, accountId, ownerAccount],
    );
  await admin.query(
    `INSERT INTO sport_profiles (id, org_id, name, profile)
     VALUES ($1, $2, 'Soccer', '{}'::jsonb)`,
    [sportProfileId, orgA],
  );
  await admin.query(
    `INSERT INTO seasons (id, org_id, name, starts_on, ends_on, status)
     VALUES ($1, $2, 'Current', '2026-08-01', '2026-12-31', 'active'),
            ($3, $2, 'Prior', '2025-08-01', '2025-12-31', 'archived')`,
    [seasonId, orgA, priorSeasonId],
  );
  await admin.query(
    `INSERT INTO programs (id, org_id, season_id, sport_profile_id, mode, name, slug, status, visibility, starts_on, ends_on)
     VALUES ($1, $2, $3, $4, 'tryout', 'Tryout', 'tryout-a', 'published', 'private', '2026-09-01', '2026-09-30'),
            ($5, $2, $3, $4, 'club', 'Competitive', 'competitive-a', 'published', 'private', '2026-10-01', '2026-12-31'),
            ($6, $2, $7, $4, 'club', 'Prior Comp', 'prior-comp', 'archived', 'private', '2025-09-01', '2025-12-31')`,
    [
      tryoutProgramId,
      orgA,
      seasonId,
      sportProfileId,
      targetProgramId,
      priorProgramId,
      priorSeasonId,
    ],
  );
  await admin.query(
    `INSERT INTO divisions (id, org_id, program_id, name)
     VALUES ($1, $2, $3, 'U10'), ($4, $2, $3, 'U10B'), ($5, $2, $6, 'U10')`,
    [
      divisionId,
      orgA,
      targetProgramId,
      smallDivisionId,
      priorDivisionId,
      priorProgramId,
    ],
  );
  await admin.query(
    `INSERT INTO divisions (id, org_id, program_id, name) VALUES ($1, $2, $3, 'Tryout U10')`,
    [tryoutDivisionId, orgA, tryoutProgramId],
  );
  await admin.query(
    `INSERT INTO households (id, org_id, name) VALUES ($1, $2, 'Household A'), ($3, $2, 'Household B')`,
    [householdId, orgA, householdB],
  );
  await admin.query(
    `INSERT INTO people (id, org_id, first_name, last_name, date_of_birth, competition_gender, school_name)
     VALUES ($1, $2, 'Eval', 'One', '1980-01-01', NULL, NULL),
            ($3, $2, 'Eval', 'Two', '1981-01-01', NULL, NULL),
            ($4, $2, 'Guardian', 'Person', '1982-01-01', NULL, NULL),
            ($5, $2, 'Kid', 'Alpha', '2017-04-15', 'female', 'North'),
            ($6, $2, 'Kid', 'Beta', '2017-06-20', 'female', 'North'),
            ($7, $2, 'Kid', 'Gamma', '2017-08-25', 'female', 'South'),
            ($8, $2, 'Kid', 'Delta', '2017-03-10', 'female', 'North'),
            ($9, $2, 'Kid', 'Echo', '2017-05-12', 'female', 'South')`,
    [
      evaluatorPersonA,
      orgA,
      evaluatorPersonB,
      guardianPerson,
      childA,
      childB,
      childC,
      childD,
      childE,
    ],
  );
  await admin.query(
    `INSERT INTO household_members (id, org_id, household_id, person_id, role, is_primary_contact)
     VALUES ($1, $2, $3, $4, 'guardian', true), ($5, $2, $3, $6, 'athlete', false),
            ($7, $2, $8, $9, 'athlete', false), ($10, $2, $8, $11, 'athlete', false)`,
    [
      randomUUID(),
      orgA,
      householdId,
      guardianPerson,
      randomUUID(),
      childA,
      randomUUID(),
      householdB,
      childB,
      randomUUID(),
      childC,
    ],
  );
  await admin.query(
    `INSERT INTO person_account_links (id, org_id, person_id, account_id, relationship, verified_at)
     VALUES ($1, $2, $3, $4, 'guardian', now()), ($5, $2, $6, $7, 'self', now()), ($8, $2, $9, $10, 'self', now())`,
    [
      randomUUID(),
      orgA,
      childA,
      guardianAccount,
      randomUUID(),
      evaluatorPersonA,
      evaluatorAccountA,
      randomUUID(),
      evaluatorPersonB,
      evaluatorAccountB,
    ],
  );
  for (const [index, teamSeasonId] of teamSeasonIds.entries()) {
    const teamId = randomUUID();
    await admin.query(
      `INSERT INTO teams (id, org_id, name, sport_profile_id) VALUES ($1, $2, $3, $4)`,
      [teamId, orgA, `Team ${String(index)}`, sportProfileId],
    );
    await admin.query(
      `INSERT INTO team_seasons (id, org_id, team_id, program_id, division_id, roster_limit, status)
       VALUES ($1, $2, $3, $4, $5, 2, 'forming')`,
      [teamSeasonId, orgA, teamId, targetProgramId, divisionId],
    );
  }
  await admin.query(
    `INSERT INTO teams (id, org_id, name, sport_profile_id) VALUES ($1, $2, 'Prior Hawks', $3)`,
    [priorTeamId, orgA, sportProfileId],
  );
  await admin.query(
    `INSERT INTO teams (id, org_id, name, sport_profile_id) VALUES ($1, $2, 'Small Side', $3)`,
    [randomUUID(), orgA, sportProfileId],
  );
  await admin.query(
    `INSERT INTO team_seasons (id, org_id, team_id, program_id, division_id, roster_limit, status)
     SELECT $1, $2, t.id, $3, $4, 1, 'forming' FROM teams t WHERE t.org_id=$2 AND t.name='Small Side'`,
    [smallTeamSeasonId, orgA, targetProgramId, smallDivisionId],
  );
  await admin.query(
    `INSERT INTO team_seasons (id, org_id, team_id, program_id, division_id, status)
     VALUES ($1, $2, $3, $4, $5, 'completed')`,
    [priorTeamSeasonId, orgA, priorTeamId, priorProgramId, priorDivisionId],
  );
  await admin.query(
    `INSERT INTO registration_offerings (id, org_id, program_id, division_id, name, registrant_role, price_cents, active)
     VALUES ($1, $2, $3, $4, 'Competitive fee', 'athlete', 25000, true)`,
    [offeringId, orgA, targetProgramId, divisionId],
  );
  await admin.query(
    `INSERT INTO registration_offerings (id, org_id, program_id, division_id, name, registrant_role, price_cents, active)
     VALUES ($1, $2, $3, $4, 'Tryout fee', 'athlete', 0, true)`,
    [tryoutOfferingId, orgA, tryoutProgramId, tryoutDivisionId],
  );
  for (const personId of [childA, childB, childC, childD, childE]) {
    const registrationId = randomUUID();
    tryoutRegistrationIds.set(personId, registrationId);
    await admin.query(
      `INSERT INTO registrations (id, org_id, program_id, division_id, offering_id, person_id, household_id, registered_by_account_id, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'staff', 'confirmed')`,
      [
        registrationId,
        orgA,
        tryoutProgramId,
        tryoutDivisionId,
        tryoutOfferingId,
        personId,
        personId === childA ? householdId : householdB,
        guardianAccount,
      ],
    );
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
  await admin.end();
});

describe('Phase 6 evaluations integration', () => {
  it('creates an event, session and group-matched participants with sequential bibs', async () => {
    const event = await createEvaluationEvent(dependencies(), ownerContext, {
      tryoutProgramId,
      targetProgramId,
      name: 'Fall tryout',
      normalization: 'z_score_per_evaluator',
      shareResultsWithFamilies: false,
      criteria: [
        {
          key: 'speed',
          label: 'Speed',
          weight: 1,
          scaleMin: 1,
          scaleMax: 5,
          positionSpecific: false,
          positionKeys: [],
        },
        {
          key: 'skill',
          label: 'Skill',
          weight: 2,
          scaleMin: 1,
          scaleMax: 5,
          positionSpecific: false,
          positionKeys: [],
        },
      ],
      groups: [
        {
          name: 'U10',
          ageMinMonths: 96,
          ageMaxMonths: 120,
          gender: 'female',
          positionKeys: [],
        },
        {
          name: 'U10B',
          ageMinMonths: 96,
          ageMaxMonths: 120,
          gender: 'female',
          positionKeys: [],
        },
      ],
    });
    if (!event) throw new Error('Expected an evaluation event');
    eventId = event.id;
    expect(event.status).toBe('draft');

    const session = await createEvaluationSession(
      dependencies(),
      ownerContext,
      eventId,
      {
        groupId: null,
        name: 'Session 1',
        startsAt: '2026-09-28T15:00:00.000Z',
        endsAt: '2026-09-28T17:00:00.000Z',
        timezone: 'America/Chicago',
        facilityId: null,
        capacity: 5,
      },
    );
    sessionId = session.id;
    const calendar = await admin.query<{ kind: string; title: string }>(
      `SELECT kind, title FROM events WHERE org_id=$1 AND id=$2`,
      [orgA, session.calendarEventId],
    );
    expect(calendar.rows[0]).toEqual({
      kind: 'evaluation_session',
      title: 'Session 1',
    });

    const first = await assignEvaluationParticipant(
      dependencies(),
      ownerContext,
      eventId,
      {
        personId: childA,
        groupId: null,
        sessionId,
        registrationId: tryoutRegistrationFor(childA),
        positionKeys: [],
      },
    );
    const second = await assignEvaluationParticipant(
      dependencies(),
      ownerContext,
      eventId,
      {
        personId: childB,
        groupId: null,
        sessionId,
        registrationId: tryoutRegistrationFor(childB),
        positionKeys: [],
      },
    );
    const third = await assignEvaluationParticipant(
      dependencies(),
      ownerContext,
      eventId,
      {
        personId: childC,
        groupId: null,
        sessionId,
        registrationId: tryoutRegistrationFor(childC),
        positionKeys: [],
      },
    );
    participantA = first.id;
    participantB = second.id;
    participantC = third.id;
    expect(first.bibNumber).toBe(1);
    expect(second.bibNumber).toBe(2);
    expect(third.bibNumber).toBe(3);

    const smallGroup = await admin.query<{ id: string }>(
      `SELECT id FROM evaluation_groups WHERE org_id=$1 AND evaluation_event_id=$2 AND name='U10B'`,
      [orgA, eventId],
    );
    const smallGroupRow = smallGroup.rows[0];
    if (!smallGroupRow) throw new Error('Expected the U10B evaluation group');
    groupBId = smallGroupRow.id;
    const mainGroup = await admin.query<{ id: string }>(
      `SELECT id FROM evaluation_groups WHERE org_id=$1 AND evaluation_event_id=$2 AND name='U10'`,
      [orgA, eventId],
    );
    const mainGroupRow = mainGroup.rows[0];
    if (!mainGroupRow) throw new Error('Expected the U10 evaluation group');
    groupAId = mainGroupRow.id;
    participantD = (
      await assignEvaluationParticipant(dependencies(), ownerContext, eventId, {
        personId: childD,
        groupId: groupBId,
        sessionId,
        registrationId: tryoutRegistrationFor(childD),
        positionKeys: [],
      })
    ).id;
    participantE = (
      await assignEvaluationParticipant(dependencies(), ownerContext, eventId, {
        personId: childE,
        groupId: groupBId,
        sessionId,
        registrationId: tryoutRegistrationFor(childE),
        positionKeys: [],
      })
    ).id;

    await expect(
      assignEvaluationParticipant(dependencies(), ownerContext, eventId, {
        personId: childA,
        groupId: null,
        sessionId,
        registrationId: tryoutRegistrationFor(childA),
        positionKeys: [],
      }),
    ).rejects.toMatchObject({ status: 409, code: 'CAPACITY_EXCEEDED' });

    await expect(
      assignEvaluationParticipant(dependencies(), ownerContext, eventId, {
        personId: guardianPerson,
        groupId: null,
        sessionId: null,
        registrationId: randomUUID(),
        positionKeys: [],
      }),
    ).rejects.toMatchObject({ status: 422, code: 'GROUP_NOT_ELIGIBLE' });
    await expect(
      createEvaluationEvent(dependencies(), orgBContext, {
        tryoutProgramId,
        targetProgramId,
        name: 'Cross-tenant',
        normalization: 'none',
        shareResultsWithFamilies: false,
        criteria: [
          {
            key: 'a',
            label: 'A',
            weight: 1,
            scaleMin: 1,
            scaleMax: 5,
            positionSpecific: false,
            positionKeys: [],
          },
        ],
        groups: [
          {
            name: 'Open',
            ageMinMonths: null,
            ageMaxMonths: null,
            gender: 'open',
            positionKeys: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('checks participants in once and gates evaluator assignment through compliance', async () => {
    const checked = await checkInEvaluationParticipant(
      dependencies(),
      ownerContext,
      participantA,
    );
    expect(checked.check_in_status).toBe('checked_in');
    const repeated = await checkInEvaluationParticipant(
      dependencies(),
      ownerContext,
      participantA,
    );
    expect(repeated.check_in_status).toBe('checked_in');
    expect(repeated.version).toBe(checked.version);

    const candidates = await listEvaluationEvaluatorCandidates(
      dependencies(),
      ownerContext,
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({
        accountId: evaluatorAccountA,
        firstName: 'Acct3',
        lastName: 'Phase6',
      }),
    );

    const assigned = await assignEvaluationEvaluator(
      dependencies(),
      ownerContext,
      sessionId,
      evaluatorAccountA,
    );
    expect(assigned.accountId).toBe(evaluatorAccountA);
    const second = await assignEvaluationEvaluator(
      dependencies(),
      ownerContext,
      sessionId,
      evaluatorAccountB,
    );
    expect(second.accountId).toBe(evaluatorAccountB);
  });

  it('persists concurrent evaluator scores and dedupes clientMutationId replays', async () => {
    const sheet = await import('./service').then((module) =>
      module.listEvaluationScoringSheet(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountA,
        true,
      ),
    );
    const firstCriterion = sheet.criteria[0];
    if (!firstCriterion) throw new Error('Expected at least one criterion');
    criterionId = String(firstCriterion.id);

    const [one, two] = await Promise.all([
      upsertEvaluationScore(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountA,
        {
          participantId: participantA,
          criterionId,
          score: 5,
          notes: null,
          clientMutationId: randomUUID(),
        },
        true,
      ),
      upsertEvaluationScore(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountB,
        {
          participantId: participantA,
          criterionId,
          score: 3,
          notes: 'harsher',
          clientMutationId: randomUUID(),
        },
        true,
      ),
    ]);
    expect(one.id).not.toBe(two.id);

    const mutationId = randomUUID();
    const saved = await upsertEvaluationScore(
      dependencies(),
      ownerContext,
      eventId,
      evaluatorAccountA,
      {
        participantId: participantB,
        criterionId,
        score: 4,
        notes: null,
        clientMutationId: mutationId,
      },
      true,
    );
    const replay = await upsertEvaluationScore(
      dependencies(),
      ownerContext,
      eventId,
      evaluatorAccountA,
      {
        participantId: participantB,
        criterionId,
        score: 4,
        notes: null,
        clientMutationId: mutationId,
      },
      true,
    );
    expect(replay.id).toBe(saved.id);

    const withOrg = createWithOrg(database);
    const count = await withOrg(ownerContext, async (trx) => {
      const result = await trx
        .selectFrom('evaluation_scores')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('evaluation_participant_id', '=', participantA)
        .where('evaluation_criterion_id', '=', criterionId)
        .executeTakeFirstOrThrow();
      return Number(result.count);
    });
    expect(count).toBe(2);

    await expect(
      upsertEvaluationScore(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountA,
        {
          participantId: participantA,
          criterionId,
          score: 99,
          notes: null,
          clientMutationId: randomUUID(),
        },
        true,
      ),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_SCORE' });
  });

  it('computes normalized results and ranks athletes', async () => {
    await expect(
      assignEvaluationParticipant(dependencies(), ownerContext, eventId, {
        personId: guardianPerson,
        groupId: null,
        sessionId: null,
        registrationId: randomUUID(),
        positionKeys: [],
      }),
    ).rejects.toMatchObject({ status: 409, code: 'EVENT_LOCKED' });
    const sheet = await import('./service').then((module) =>
      module.listEvaluationScoringSheet(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountA,
        true,
      ),
    );
    const skill = sheet.criteria.find((row) => String(row.key) === 'skill');
    if (!skill) throw new Error('Expected skill criterion on scoring sheet');
    const skillCriterionId = String(skill.id);
    for (const [participant, speed, skillScore] of [
      [participantA, 5, 5],
      [participantB, 4, 3],
      [participantC, 2, 2],
      [participantD, 5, 4],
      [participantE, 3, 2],
    ] as const) {
      await upsertEvaluationScore(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountA,
        {
          participantId: participant,
          criterionId,
          score: speed,
          notes: null,
          clientMutationId: randomUUID(),
        },
        true,
      );
      await upsertEvaluationScore(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountA,
        {
          participantId: participant,
          criterionId: skillCriterionId,
          score: skillScore,
          notes: null,
          clientMutationId: randomUUID(),
        },
        true,
      );
      await upsertEvaluationScore(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountB,
        {
          participantId: participant,
          criterionId,
          score: Math.max(1, speed - 2),
          notes: null,
          clientMutationId: randomUUID(),
        },
        true,
      );
      await upsertEvaluationScore(
        dependencies(),
        ownerContext,
        eventId,
        evaluatorAccountB,
        {
          participantId: participant,
          criterionId: skillCriterionId,
          score: Math.max(1, skillScore - 2),
          notes: null,
          clientMutationId: randomUUID(),
        },
        true,
      );
    }
    const results = await computeEvaluationResults(
      dependencies(),
      ownerContext,
      eventId,
    );
    const alpha = results.find((row) => row.participantId === participantA);
    const gamma = results.find((row) => row.participantId === participantC);
    expect(alpha?.rankInGroup).toBe(1);
    expect(gamma?.rankInGroup).toBe(3);
    expect(alpha?.evaluatorCount).toBe(2);
    const consistency = await evaluationConsistency(
      dependencies(),
      ownerContext,
      eventId,
    );
    expect(consistency).toContainEqual(
      expect.objectContaining({
        evaluatorId: evaluatorAccountA,
        evaluatorName: 'Acct3 Phase6',
        criterionKey: 'speed',
        scoreCount: 5,
      }),
    );
  });

  it('builds, locks, moves and publishes a placement board', async () => {
    const board = await createPlacementBoard(
      dependencies(),
      ownerContext,
      eventId,
      targetProgramId,
      {
        divisionId,
        evaluationGroupId: groupAId,
        seed: 7,
        siblingsTogether: false,
        returningStay: false,
        positionMinimums: {},
      },
    );
    boardId = board.id;
    expect(Object.keys(board.assignments)).toHaveLength(3);
    const destinationTeamSeason = teamSeasonIds[0];
    if (!destinationTeamSeason) throw new Error('Expected a team season');
    await expect(
      movePlacement(
        dependencies(),
        ownerContext,
        boardId,
        childA,
        destinationTeamSeason,
        99,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    const detail = await getPlacementBoard(
      dependencies(),
      ownerContext,
      boardId,
    );
    const placed = detail.placements.find((row) => row.personId === childA);
    if (!placed) throw new Error('Expected childA placement');
    const locked = await lockPlacement(
      dependencies(),
      ownerContext,
      boardId,
      childA,
      'keeper',
    );
    expect(locked.locked).toBe(true);
    await expect(
      movePlacement(
        dependencies(),
        ownerContext,
        boardId,
        childA,
        destinationTeamSeason,
        placed.version,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'PLACEMENT_LOCKED' });
    await publishPlacementBoard(dependencies(), ownerContext, boardId);
  });

  it('sends, accepts, replays and dashboards offers through the checkout adapter', async () => {
    const withOrg = createWithOrg(database);
    const placementA = await withOrg(ownerContext, async (trx) =>
      trx
        .selectFrom('team_placements')
        .select('id')
        .where('placement_board_id', '=', boardId)
        .where('person_id', '=', childA)
        .executeTakeFirstOrThrow(),
    );
    const offer = await createTeamOffer(
      dependencies(),
      ownerContext,
      placementA.id,
      offeringId,
      25000,
      5000,
      new Date(clockNow.getTime() + 72 * 3_600_000).toISOString(),
      'Welcome to the team',
    );
    offerId = offer.id;

    const notifications = await admin.query(
      `SELECT type, payload->>'resourceId' AS resource FROM notifications WHERE org_id=$1 AND account_id=$2`,
      [orgA, guardianAccount],
    );
    expect(
      notifications.rows.some(
        (row: { type: string; resource: string | null }) =>
          row.type === 'evaluation.offer' && row.resource === offerId,
      ),
    ).toBe(true);

    const family = await listFamilyOffers(dependencies(), guardianContext);
    expect(family.map((row) => row.id)).toContain(offerId);
    const outsider = await listFamilyOffers(dependencies(), outsiderContext);
    expect(outsider).toHaveLength(0);

    const checkout = new FakeCheckout(admin);
    const accepted = await acceptTeamOffer(
      dependencies(),
      guardianContext,
      offerId,
      checkout,
    );
    expect(accepted.status).toBe('accepted');
    expect(checkout.calls).toBe(1);
    const replay = await acceptTeamOffer(
      dependencies(),
      guardianContext,
      offerId,
      checkout,
    );
    expect(replay.registrationId).toBe(accepted.registrationId);
    expect(checkout.calls).toBe(1);

    const dashboard = await listOfferDashboard(
      dependencies(),
      ownerContext,
      boardId,
    );
    const teamRow = dashboard.teams.find((row) => row.accepted > 0);
    expect(teamRow).toBeTruthy();
  });

  it('declines, withdraws, reminds and expires offers correctly', async () => {
    const withOrg = createWithOrg(database);
    const placementB = await withOrg(ownerContext, async (trx) =>
      trx
        .selectFrom('team_placements')
        .select('id')
        .where('placement_board_id', '=', boardId)
        .where('person_id', '=', childB)
        .executeTakeFirstOrThrow(),
    );
    const offerB = await createTeamOffer(
      dependencies(),
      ownerContext,
      placementB.id,
      offeringId,
      25000,
      5000,
      new Date(clockNow.getTime() + 10 * 3_600_000).toISOString(),
      null,
    );
    const reminded = await sendOfferReminders(dependencies(), ownerContext, 48);
    expect(reminded.reminded).toBe(1);
    const again = await sendOfferReminders(dependencies(), ownerContext, 48);
    expect(again.reminded).toBe(0);

    // childB lives in householdB without a linked guardian, so decline by guardian fails.
    await expect(
      declineTeamOffer(dependencies(), guardianContext, offerB.id, 'no', 1),
    ).rejects.toMatchObject({ status: 404 });
    const withdrawn = await withdrawTeamOffer(
      dependencies(),
      ownerContext,
      offerB.id,
    );
    expect(withdrawn.id).toBe(offerB.id);

    const placementC = await withOrg(ownerContext, async (trx) =>
      trx
        .selectFrom('team_placements')
        .select('id')
        .where('placement_board_id', '=', boardId)
        .where('person_id', '=', childC)
        .executeTakeFirstOrThrow(),
    );
    await createTeamOffer(
      dependencies(),
      ownerContext,
      placementC.id,
      offeringId,
      25000,
      5000,
      new Date(clockNow.getTime() + 3_600_000).toISOString(),
      null,
    );
    clockNow = new Date(clockNow.getTime() + 2 * 3_600_000);
    const expired = await expireTeamOffers(dependencies(), ownerContext);
    expect(expired.expired).toBe(1);
    const placement = await withOrg(ownerContext, async (trx) =>
      trx
        .selectFrom('team_placements')
        .select('status')
        .where('id', '=', placementC.id)
        .executeTakeFirstOrThrow(),
    );
    expect(placement.status).toBe('declined');
  });

  it('shares results with families only when the event allows it', async () => {
    const hidden = await listMyEvaluationResults(
      dependencies(),
      guardianContext,
    );
    expect(hidden.find((row) => row.personId === childA)).toBeUndefined();
    await admin.query(
      `UPDATE evaluation_events SET share_results_with_families=true WHERE id=$1`,
      [eventId],
    );
    const visible = await listMyEvaluationResults(
      dependencies(),
      guardianContext,
    );
    const row = visible.find((item) => item.personId === childA);
    expect(row).toBeTruthy();
    if (!row) throw new Error('Expected a family-visible result');
    expect(row.composite).not.toBeNull();
    expect(visible.find((item) => item.personId === childB)).toBeUndefined();
  });

  it('seeds a rec-league board from registrations with mutual friends and returning teams', async () => {
    const recProgramId = randomUUID();
    const recDivisionId = randomUUID();
    await admin.query(
      `INSERT INTO programs (id, org_id, season_id, sport_profile_id, mode, name, slug, status, visibility, starts_on, ends_on)
       VALUES ($1, $2, $3, $4, 'league', 'Rec League', 'rec-a', 'published', 'private', '2026-09-01', '2026-12-31')`,
      [recProgramId, orgA, seasonId, sportProfileId],
    );
    await admin.query(
      `INSERT INTO divisions (id, org_id, program_id, name) VALUES ($1, $2, $3, 'Rec U10')`,
      [recDivisionId, orgA, recProgramId],
    );
    const recOffering = randomUUID();
    await admin.query(
      `INSERT INTO registration_offerings (id, org_id, program_id, division_id, name, registrant_role, price_cents, active)
       VALUES ($1, $2, $3, $4, 'Rec fee', 'athlete', 12000, true)`,
      [recOffering, orgA, recProgramId, recDivisionId],
    );
    const recTeams: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const teamId = randomUUID();
      await admin.query(
        `INSERT INTO teams (id, org_id, name, sport_profile_id) VALUES ($1, $2, $3, $4)`,
        [teamId, orgA, `Rec ${String(index)}`, sportProfileId],
      );
      const recTeamSeason = randomUUID();
      await admin.query(
        `INSERT INTO team_seasons (id, org_id, team_id, program_id, division_id, status)
         VALUES ($1, $2, $3, $4, $5, 'forming')`,
        [recTeamSeason, orgA, teamId, recProgramId, recDivisionId],
      );
      recTeams.push(recTeamSeason);
    }
    const returningTeamSeason = randomUUID();
    await admin.query(
      `INSERT INTO team_seasons (id, org_id, team_id, program_id, division_id, status)
       VALUES ($1, $2, $3, $4, $5, 'forming')`,
      [returningTeamSeason, orgA, priorTeamId, recProgramId, recDivisionId],
    );
    await admin.query(
      `INSERT INTO roster_entries (id, org_id, team_season_id, person_id, kind, status, joined_on)
       VALUES ($1, $2, $3, $4, 'rostered', 'active', '2025-09-01')`,
      [randomUUID(), orgA, priorTeamSeasonId, childC],
    );
    const extraKids = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    for (const [index, personId] of [
      childA,
      childB,
      childC,
      ...extraKids,
    ].entries()) {
      if (index >= 3)
        await admin.query(
          `INSERT INTO people (id, org_id, first_name, last_name, date_of_birth) VALUES ($1, $2, $3, 'Rec', '2017-01-01')`,
          [personId, orgA, `Kid${String(index)}`],
        );
      await admin.query(
        `INSERT INTO registrations (id, org_id, program_id, division_id, offering_id, person_id, household_id, registered_by_account_id, source, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'online', 'confirmed')`,
        [
          randomUUID(),
          orgA,
          recProgramId,
          recDivisionId,
          recOffering,
          personId,
          householdId,
          guardianAccount,
        ],
      );
    }
    // Mutual friend request between childA and childB.
    await upsertPlacementPreference(
      dependencies(),
      ownerContext,
      recProgramId,
      {
        personId: childA,
        friendRequestPersonId: childB,
        practiceLocation: 'North',
        coachRating: 4.5,
        note: null,
        source: 'family',
      },
    );
    await upsertMyPlacementPreference(
      dependencies(),
      guardianContext,
      recProgramId,
      {
        personId: childA,
        friendRequestPersonId: childB,
        practiceLocation: 'North',
      },
    );
    const familyPrograms = await listMyPlacementPrograms(
      dependencies(),
      guardianContext,
    );
    expect(familyPrograms).toContainEqual(
      expect.objectContaining({
        programId: recProgramId,
        personId: childA,
        programName: 'Rec League',
      }),
    );
    await expect(
      upsertMyPlacementPreference(
        dependencies(),
        outsiderContext,
        recProgramId,
        {
          personId: childA,
          friendRequestPersonId: childB,
          practiceLocation: null,
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await upsertPlacementPreference(
      dependencies(),
      ownerContext,
      recProgramId,
      {
        personId: childB,
        friendRequestPersonId: childA,
        practiceLocation: null,
        coachRating: 3,
        note: null,
        source: 'staff',
      },
    );
    const prefs = await listPlacementPreferences(
      dependencies(),
      ownerContext,
      recProgramId,
    );
    expect(prefs.length).toBe(2);
    expect(prefs.find((row) => row.personId === childA)).toMatchObject({
      coachRating: 4.5,
      source: 'family',
    });

    const board = await createPlacementBoard(
      dependencies(),
      ownerContext,
      null,
      recProgramId,
      {
        divisionId: recDivisionId,
        evaluationGroupId: null,
        seed: 11,
        siblingsTogether: true,
        returningStay: true,
        positionMinimums: {},
      },
    );
    expect(board.assignments[childA]).toBe(board.assignments[childB]);
    expect(board.assignments[childC]).toBe(returningTeamSeason);
    expect(Object.keys(board.assignments)).toHaveLength(9);
    const detail = await getPlacementBoard(
      dependencies(),
      ownerContext,
      board.id,
    );
    expect(detail.placements).toHaveLength(9);
  });

  it('caps a tryout board at roster capacity and surfaces next-in-line athletes', async () => {
    const board = await createPlacementBoard(
      dependencies(),
      ownerContext,
      eventId,
      targetProgramId,
      {
        divisionId: smallDivisionId,
        evaluationGroupId: groupBId,
        seed: 5,
        siblingsTogether: false,
        returningStay: false,
        positionMinimums: {},
      },
    );
    expect(Object.keys(board.assignments)).toHaveLength(1);
    expect(board.assignments[childD]).toBe(smallTeamSeasonId);
    const dashboard = await listOfferDashboard(
      dependencies(),
      ownerContext,
      board.id,
    );
    expect(dashboard.nextInLine).toHaveLength(1);
    const firstInLine = dashboard.nextInLine[0];
    if (!firstInLine) throw new Error('Expected a next-in-line suggestion');
    expect(firstInLine.personId).toBe(childE);
  });
});
