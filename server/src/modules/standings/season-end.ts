import { newId } from '@shared/ids';

import type { OrgContext } from '../../db/withOrg';
import { withOrg } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { assertSchedulePermission } from '../scheduling/access';
import { SchedulingRuleError } from '../scheduling/events';

export async function createSeasonSurvey(
  context: OrgContext,
  programId: string,
  input: {
    title: string;
    locale?: 'en' | 'es';
    opensAt?: Date;
    closesAt?: Date;
  },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId,
    });
    if (input.opensAt && input.closesAt && input.closesAt <= input.opensAt)
      throw new SchedulingRuleError(
        'The survey close time must follow its open time.',
      );
    const id = newId();
    const row = await trx
      .insertInto('season_survey_campaigns')
      .values({
        id,
        org_id: context.orgId,
        program_id: programId,
        title: input.title,
        locale: input.locale ?? 'en',
        created_by: context.actor.accountId,
        opens_at: input.opensAt ?? null,
        closes_at: input.closesAt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row;
  });
}

export async function listSeasonSurveys(
  context: OrgContext,
  programId: string,
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId,
    });
    return trx
      .selectFrom('season_survey_campaigns')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', programId)
      .orderBy('created_at', 'desc')
      .execute();
  });
}

export async function listFamilySeasonSurveys(context: OrgContext) {
  return withOrg(context, async (trx) => {
    const now = new Date();
    const campaigns = await trx
      .selectFrom('season_survey_campaigns')
      .innerJoin('registrations', (join) =>
        join
          .onRef('registrations.org_id', '=', 'season_survey_campaigns.org_id')
          .onRef(
            'registrations.program_id',
            '=',
            'season_survey_campaigns.program_id',
          ),
      )
      .innerJoin('household_members', (join) =>
        join
          .onRef('household_members.org_id', '=', 'registrations.org_id')
          .onRef(
            'household_members.household_id',
            '=',
            'registrations.household_id',
          )
          .onRef('household_members.person_id', '=', 'registrations.person_id'),
      )
      .innerJoin('person_account_links', (join) =>
        join
          .onRef('person_account_links.org_id', '=', 'registrations.org_id')
          .onRef(
            'person_account_links.person_id',
            '=',
            'registrations.person_id',
          ),
      )
      .select([
        'season_survey_campaigns.id',
        'season_survey_campaigns.program_id',
        'season_survey_campaigns.title',
        'season_survey_campaigns.locale',
        'season_survey_campaigns.opens_at',
        'season_survey_campaigns.closes_at',
      ])
      .where('season_survey_campaigns.org_id', '=', context.orgId)
      .where('season_survey_campaigns.status', '=', 'open')
      .where((eb) =>
        eb.or([
          eb('season_survey_campaigns.opens_at', 'is', null),
          eb('season_survey_campaigns.opens_at', '<=', now),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('season_survey_campaigns.closes_at', 'is', null),
          eb('season_survey_campaigns.closes_at', '>', now),
        ]),
      )
      .where('registrations.status', '=', 'confirmed')
      .where('household_members.role', 'in', ['guardian', 'athlete'])
      .where('person_account_links.account_id', '=', context.actor.accountId)
      .where('person_account_links.relationship', 'in', ['guardian', 'self'])
      .where('person_account_links.verified_at', 'is not', null)
      .where('person_account_links.revoked_at', 'is', null)
      .distinct()
      .execute();
    if (!campaigns.length) return [];
    const responded = await trx
      .selectFrom('season_survey_responses')
      .select('campaign_id')
      .where('org_id', '=', context.orgId)
      .where('respondent_account_id', '=', context.actor.accountId)
      .where(
        'campaign_id',
        'in',
        campaigns.map((campaign) => campaign.id),
      )
      .execute();
    const respondedIds = new Set(responded.map((row) => row.campaign_id));
    return campaigns.filter((campaign) => !respondedIds.has(campaign.id));
  });
}

export async function changeSeasonSurveyStatus(
  context: OrgContext,
  campaignId: string,
  expectedVersion: number,
  status: 'open' | 'closed' | 'archived',
) {
  return withOrg(context, async (trx) => {
    const campaign = await trx
      .selectFrom('season_survey_campaigns')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .executeTakeFirst();
    if (!campaign)
      throw new SchedulingRuleError('Survey not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId: campaign.program_id,
    });
    if (campaign.version !== expectedVersion)
      throw new VersionConflictError(campaign);
    const valid =
      (campaign.status === 'draft' && status === 'open') ||
      (campaign.status === 'open' && status === 'closed') ||
      (campaign.status === 'closed' && status === 'archived');
    if (!valid)
      throw new SchedulingRuleError(
        'Survey status can only move from draft to open, open to closed, and closed to archived.',
        409,
        'CONFLICT',
      );
    return trx
      .updateTable('season_survey_campaigns')
      .set({ status, version: campaign.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function submitSeasonSurveyResponse(
  context: OrgContext,
  campaignId: string,
  input: { nps: number; responseText?: string },
) {
  return withOrg(context, async (trx) => {
    const campaign = await trx
      .selectFrom('season_survey_campaigns')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .executeTakeFirst();
    const now = new Date();
    if (
      !campaign ||
      campaign.status !== 'open' ||
      (campaign.opens_at && campaign.opens_at > now) ||
      (campaign.closes_at && campaign.closes_at <= now)
    )
      throw new SchedulingRuleError(
        'This survey is not accepting responses.',
        404,
        'NOT_FOUND',
      );
    const eligible = await trx
      .selectFrom('registrations')
      .innerJoin('household_members', (join) =>
        join
          .onRef('household_members.org_id', '=', 'registrations.org_id')
          .onRef(
            'household_members.household_id',
            '=',
            'registrations.household_id',
          )
          .onRef('household_members.person_id', '=', 'registrations.person_id'),
      )
      .innerJoin('person_account_links', (join) =>
        join
          .onRef('person_account_links.org_id', '=', 'registrations.org_id')
          .onRef(
            'person_account_links.person_id',
            '=',
            'registrations.person_id',
          ),
      )
      .select('registrations.id')
      .where('registrations.org_id', '=', context.orgId)
      .where('registrations.program_id', '=', campaign.program_id)
      .where('registrations.status', '=', 'confirmed')
      .where('household_members.role', 'in', ['guardian', 'athlete'])
      .where('person_account_links.account_id', '=', context.actor.accountId)
      .where('person_account_links.relationship', 'in', ['guardian', 'self'])
      .where('person_account_links.verified_at', 'is not', null)
      .where('person_account_links.revoked_at', 'is', null)
      .executeTakeFirst();
    if (!eligible)
      throw new SchedulingRuleError(
        'A verified account linked to a currently registered family member is required.',
        403,
        'FORBIDDEN',
      );
    return trx
      .insertInto('season_survey_responses')
      .values({
        id: newId(),
        org_id: context.orgId,
        campaign_id: campaignId,
        respondent_account_id: context.actor.accountId,
        nps: input.nps,
        response_text: input.responseText ?? null,
      })
      .returning(['id', 'campaign_id', 'created_at'])
      .executeTakeFirstOrThrow();
  });
}

export async function getSeasonSurveyResults(
  context: OrgContext,
  campaignId: string,
) {
  return withOrg(context, async (trx) => {
    const campaign = await trx
      .selectFrom('season_survey_campaigns')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .executeTakeFirst();
    if (!campaign)
      throw new SchedulingRuleError('Survey not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId: campaign.program_id,
    });
    const responses = await trx
      .selectFrom('season_survey_responses')
      .select(['nps', 'response_text', 'created_at'])
      .where('org_id', '=', context.orgId)
      .where('campaign_id', '=', campaignId)
      .orderBy('created_at')
      .execute();
    const scored = responses.filter((response) => response.nps !== null);
    const promoters = scored.filter(
      (response) => (response.nps ?? 0) >= 9,
    ).length;
    const detractors = scored.filter(
      (response) => (response.nps ?? 0) <= 6,
    ).length;
    return {
      campaign,
      responseCount: responses.length,
      nps: scored.length
        ? Math.round(((promoters - detractors) / scored.length) * 100)
        : null,
      comments: responses
        .filter((response) => response.response_text)
        .map((response) => ({
          text: response.response_text,
          at: response.created_at,
        })),
    };
  });
}

export async function saveCoachPlayerRating(
  context: OrgContext,
  input: {
    teamSeasonId: string;
    personId: string;
    rating: number;
    returningNextSeason?: boolean;
    notes?: string;
    expectedVersion?: number;
  },
) {
  return withOrg(context, async (trx) => {
    const team = await trx
      .selectFrom('team_seasons')
      .select(['id', 'program_id'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.teamSeasonId)
      .executeTakeFirst();
    if (!team)
      throw new SchedulingRuleError('Team not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'results.manage', {
      programId: team.program_id,
      teamSeasonId: team.id,
    });
    const rosterEntry = await trx
      .selectFrom('roster_entries')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', team.id)
      .where('person_id', '=', input.personId)
      .where('status', 'in', ['active', 'injured', 'suspended'])
      .executeTakeFirst();
    if (!rosterEntry)
      throw new SchedulingRuleError(
        'Only a current roster member can be rated.',
        404,
        'NOT_FOUND',
      );
    const current = await trx
      .selectFrom('coach_player_ratings')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', team.id)
      .where('person_id', '=', input.personId)
      .where('coach_account_id', '=', context.actor.accountId)
      .executeTakeFirst();
    if (current && current.version !== input.expectedVersion)
      throw new VersionConflictError(current);
    if (!current && input.expectedVersion !== undefined)
      throw new VersionConflictError({ version: 0 });
    if (current) {
      return trx
        .updateTable('coach_player_ratings')
        .set({
          criteria: { overall: input.rating },
          returning_next_season: input.returningNextSeason ?? null,
          notes: input.notes ?? null,
          version: current.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', current.id)
        .where('version', '=', current.version)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return trx
      .insertInto('coach_player_ratings')
      .values({
        id: newId(),
        org_id: context.orgId,
        program_id: team.program_id,
        team_season_id: team.id,
        person_id: input.personId,
        coach_account_id: context.actor.accountId,
        criteria: { overall: input.rating },
        returning_next_season: input.returningNextSeason ?? null,
        notes: input.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function getPriorSeasonPlayerRatings(
  context: OrgContext,
  programId: string,
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId,
    });
    const current = await trx
      .selectFrom('programs')
      .innerJoin('seasons', (join) =>
        join
          .onRef('seasons.org_id', '=', 'programs.org_id')
          .onRef('seasons.id', '=', 'programs.season_id'),
      )
      .select([
        'programs.sport_profile_id',
        'seasons.id as current_season_id',
        'seasons.starts_on as current_starts_on',
        'seasons.copied_from_season_id',
      ])
      .where('programs.org_id', '=', context.orgId)
      .where('programs.id', '=', programId)
      .executeTakeFirst();
    if (!current)
      throw new SchedulingRuleError('Program not found.', 404, 'NOT_FOUND');
    let priorSeasonId = current.copied_from_season_id;
    if (!priorSeasonId) {
      const prior = await trx
        .selectFrom('seasons')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('ends_on', '<', current.current_starts_on)
        .orderBy('ends_on', 'desc')
        .executeTakeFirst();
      priorSeasonId = prior?.id ?? null;
    }
    if (!priorSeasonId) return { seasonId: null, ratings: [] };
    const rows = await trx
      .selectFrom('coach_player_ratings')
      .innerJoin('programs', (join) =>
        join
          .onRef('programs.org_id', '=', 'coach_player_ratings.org_id')
          .onRef('programs.id', '=', 'coach_player_ratings.program_id'),
      )
      .select([
        'coach_player_ratings.person_id',
        'coach_player_ratings.criteria',
        'coach_player_ratings.returning_next_season',
      ])
      .where('coach_player_ratings.org_id', '=', context.orgId)
      .where('programs.season_id', '=', priorSeasonId)
      .where('programs.sport_profile_id', '=', current.sport_profile_id)
      .execute();
    const grouped = new Map<
      string,
      { values: number[]; returning: boolean[] }
    >();
    for (const row of rows) {
      const criteria = row.criteria as { overall?: unknown };
      if (typeof criteria.overall !== 'number') continue;
      const entry = grouped.get(row.person_id) ?? { values: [], returning: [] };
      entry.values.push(criteria.overall);
      if (row.returning_next_season !== null)
        entry.returning.push(row.returning_next_season);
      grouped.set(row.person_id, entry);
    }
    return {
      seasonId: priorSeasonId,
      ratings: [...grouped].map(([personId, entry]) => ({
        personId,
        rating:
          entry.values.reduce((sum, value) => sum + value, 0) /
          entry.values.length,
        returningNextSeason:
          entry.returning.length > 0 &&
          entry.returning.filter(Boolean).length * 2 >= entry.returning.length,
      })),
    };
  });
}

export async function createSeasonAward(
  context: OrgContext,
  input: {
    programId: string;
    personId?: string;
    teamSeasonId?: string;
    title: string;
    description?: string;
    certificateFileId?: string;
  },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId: input.programId,
    });
    if (Boolean(input.personId) === Boolean(input.teamSeasonId))
      throw new SchedulingRuleError('Choose one award recipient type.');
    if (input.personId) {
      const registered = await trx
        .selectFrom('registrations')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('program_id', '=', input.programId)
        .where('person_id', '=', input.personId)
        .where('status', '=', 'confirmed')
        .executeTakeFirst();
      if (!registered)
        throw new SchedulingRuleError(
          'The award recipient must be registered in this program.',
        );
    }
    if (input.teamSeasonId) {
      const team = await trx
        .selectFrom('team_seasons')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('program_id', '=', input.programId)
        .where('id', '=', input.teamSeasonId)
        .executeTakeFirst();
      if (!team)
        throw new SchedulingRuleError('Team not found.', 404, 'NOT_FOUND');
    }
    return trx
      .insertInto('season_awards')
      .values({
        id: newId(),
        org_id: context.orgId,
        program_id: input.programId,
        person_id: input.personId ?? null,
        team_season_id: input.teamSeasonId ?? null,
        title: input.title,
        description: input.description ?? null,
        certificate_file_id: input.certificateFileId ?? null,
        issued_by: context.actor.accountId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function listSeasonAwards(context: OrgContext, programId: string) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId,
    });
    return trx
      .selectFrom('season_awards')
      .leftJoin('people', (join) =>
        join
          .onRef('people.org_id', '=', 'season_awards.org_id')
          .onRef('people.id', '=', 'season_awards.person_id'),
      )
      .leftJoin('team_seasons', (join) =>
        join
          .onRef('team_seasons.org_id', '=', 'season_awards.org_id')
          .onRef('team_seasons.id', '=', 'season_awards.team_season_id'),
      )
      .selectAll('season_awards')
      .select([
        'people.first_name as recipient_first_name',
        'people.last_name as recipient_last_name',
        'team_seasons.display_name as recipient_team_name',
      ])
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', programId)
      .orderBy('issued_at', 'desc')
      .execute();
  });
}

export async function archiveSeason(
  context: OrgContext,
  seasonId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const season = await trx
      .selectFrom('seasons')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', seasonId)
      .executeTakeFirst();
    if (!season)
      throw new SchedulingRuleError('Season not found.', 404, 'NOT_FOUND');
    const programs = await trx
      .selectFrom('programs')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('season_id', '=', seasonId)
      .execute();
    if (!programs.length)
      throw new SchedulingRuleError(
        'A season without programs cannot be archived through operations.',
        409,
        'CONFLICT',
      );
    for (const program of programs)
      await assertSchedulePermission(trx, context, 'schedule.manage', {
        programId: program.id,
      });
    if (season.version !== expectedVersion)
      throw new VersionConflictError(season);
    if (
      season.status !== 'completed' ||
      programs.some(
        (program) => !['completed', 'archived'].includes(program.status),
      )
    )
      throw new SchedulingRuleError(
        'Complete every program in the season before archiving it.',
        409,
        'CONFLICT',
      );
    return trx
      .updateTable('seasons')
      .set({ status: 'archived', version: season.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', seasonId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}
