import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { ContestFormatConfig } from '@shared/sport/schema';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { createContest, submitContestResult } from './service';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for format tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

type ResultInput = Parameters<typeof submitContestResult>[2]['result'];

function validEntries(
  format: ContestFormatConfig,
  participantIds: readonly string[],
): ResultInput {
  if (format.format === 'head_to_head_score') return { home: 2, away: 1 };
  if (format.format === 'head_to_head_sets') {
    const needed = Math.ceil(format.bestOf / 2);
    return {
      sets: Array.from({ length: needed }, () => ({
        home: format.pointsPerSet,
        away: format.pointsPerSet - format.winBy,
      })),
    };
  }
  if (format.format === 'head_to_head_bout') {
    const method = format.methods[0];
    if (!method) throw new Error('Bout format has no methods.');
    return { winner: 'home', method: method.key };
  }
  if (format.format === 'multi_timed')
    return {
      entries: participantIds.map((participantId, index) => ({
        participantId,
        value: 60_000 + index * 500,
      })),
    };
  if (format.format === 'multi_measured')
    return {
      entries: participantIds.map((participantId, index) => ({
        participantId,
        attempts: [5 + index],
      })),
    };
  if (format.format === 'judged')
    return {
      entries: participantIds.map((participantId, index) => ({
        participantId,
        sheets: Array.from({ length: format.panel.judges }, () => ({
          judgeId: newId(),
          components: Object.fromEntries(
            format.panel.components.map((component) => [
              component.key,
              component.key === 'dd'
                ? 2
                : Math.min(5 - index * 0.5, component.max ?? 5),
            ]),
          ),
        })),
      })),
    };
  return {
    entries: participantIds.map((participantId, index) => ({
      participantId,
      place: index + 1,
    })),
  };
}

function invalidInput(
  format: ContestFormatConfig,
  participantId: string,
): ResultInput {
  if (format.format === 'head_to_head_score') return { home: -1, away: 1 };
  if (format.format === 'head_to_head_sets')
    return { sets: [{ home: 0, away: 0 }] };
  if (format.format === 'head_to_head_bout')
    return { winner: 'home', method: 'not_a_method' };
  if (format.format === 'multi_timed')
    return { entries: [{ participantId, value: -1 }] };
  if (format.format === 'multi_measured')
    return { entries: [{ participantId, attempts: [] }] };
  if (format.format === 'judged')
    return { entries: [{ participantId, sheets: [] }] };
  return { entries: [{ participantId, place: 0 }] };
}

describe('result entry validates every seeded sport format', () => {
  it(
    'accepts valid results and rejects malformed input across all templates',
    { timeout: 120_000 },
    async () => {
      const orgId = newId();
      const accountId = newId();
      const actor: OrgContext = { orgId, actor: { accountId } };
      const seasonId = newId();
      await database
        .insertInto('accounts')
        .values({
          id: accountId,
          email: `formats-${accountId}@example.invalid`,
          first_name: 'Format',
          last_name: 'Acceptance',
          date_of_birth: '1990-01-01',
          email_verified_at: new Date(),
        })
        .execute();
      await database
        .insertInto('organizations')
        .values({
          id: orgId,
          slug: `formats-${randomUUID().slice(0, 12)}`,
          name: 'Format Acceptance Org',
          kind: 'club',
          timezone: 'UTC',
        })
        .execute();
      const withOrg = createWithOrg(database);
      await withOrg(actor, async (trx) => {
        await trx
          .insertInto('org_memberships')
          .values({
            id: newId(),
            org_id: orgId,
            account_id: accountId,
            status: 'active',
            joined_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('role_assignments')
          .values({
            id: newId(),
            org_id: orgId,
            account_id: accountId,
            role: 'owner',
            scope_type: 'org',
            pending_mfa: false,
          })
          .execute();
        await trx
          .insertInto('seasons')
          .values({
            id: seasonId,
            org_id: orgId,
            name: 'Format Season',
            starts_on: '2026-01-01',
            ends_on: '2026-12-31',
          })
          .execute();
      });

      let checked = 0;
      for (const profile of builtInSportTemplates) {
        const profileId = newId();
        const programId = newId();
        const divisionId = newId();
        const teamSeasonIds = [newId(), newId()];
        const personIds = [newId(), newId(), newId()];
        await withOrg(actor, async (trx) => {
          await trx
            .insertInto('sport_profiles')
            .values({
              id: profileId,
              org_id: orgId,
              name: profile.key,
              profile,
            })
            .execute();
          await trx
            .insertInto('programs')
            .values({
              id: programId,
              org_id: orgId,
              season_id: seasonId,
              sport_profile_id: profileId,
              mode: 'league',
              name: `${profile.key} program`,
              slug: `fmt-${profile.key.replaceAll('_', '-')}-${randomUUID().slice(0, 8)}`,
              starts_on: '2026-01-01',
              ends_on: '2026-12-31',
            })
            .execute();
          await trx
            .insertInto('divisions')
            .values({
              id: divisionId,
              org_id: orgId,
              program_id: programId,
              name: 'Open',
              level: 'open',
            })
            .execute();
          for (const [index, teamSeasonId] of teamSeasonIds.entries()) {
            const teamId = newId();
            await trx
              .insertInto('teams')
              .values({
                id: teamId,
                org_id: orgId,
                name: `${profile.key} team ${String(index + 1)}`,
                sport_profile_id: profileId,
              })
              .execute();
            await trx
              .insertInto('team_seasons')
              .values({
                id: teamSeasonId,
                org_id: orgId,
                team_id: teamId,
                program_id: programId,
                division_id: divisionId,
              })
              .execute();
          }
          await trx
            .insertInto('people')
            .values(
              personIds.map((personId, index) => ({
                id: personId,
                org_id: orgId,
                first_name: `Athlete${String(index + 1)}`,
                last_name: profile.key,
                date_of_birth: '2012-01-01',
              })),
            )
            .execute();
        });

        for (const [formatIndex, format] of profile.contestFormats.entries()) {
          const headToHeadFormat = [
            'head_to_head_score',
            'head_to_head_sets',
            'head_to_head_bout',
          ].includes(format.format);
          const eventId = newId();
          await withOrg(actor, async (trx) => {
            await trx
              .insertInto('events')
              .values({
                id: eventId,
                org_id: orgId,
                program_id: programId,
                division_id: divisionId,
                kind: headToHeadFormat ? 'game' : 'meet',
                title: `${profile.key} format ${String(formatIndex)}`,
                starts_at: new Date('2026-10-03T14:00:00Z'),
                ends_at: new Date('2026-10-03T15:00:00Z'),
                timezone: 'UTC',
              })
              .execute();
            await trx
              .insertInto('event_participants')
              .values(
                headToHeadFormat
                  ? [
                      {
                        id: newId(),
                        org_id: orgId,
                        event_id: eventId,
                        team_season_id: teamSeasonIds[0] ?? '',
                        side: 'home',
                      },
                      {
                        id: newId(),
                        org_id: orgId,
                        event_id: eventId,
                        team_season_id: teamSeasonIds[1] ?? '',
                        side: 'away',
                      },
                    ]
                  : personIds.map((personId) => ({
                      id: newId(),
                      org_id: orgId,
                      event_id: eventId,
                      person_id: personId,
                    })),
              )
              .execute();
          });

          const contest = await createContest(actor, eventId, {
            formatIndex,
            stage: 'regular',
            countsForStandings: true,
          });
          const participants = await withOrg(actor, (trx) =>
            trx
              .selectFrom('contest_participants')
              .select('id')
              .where('org_id', '=', orgId)
              .where('contest_id', '=', contest.id)
              .execute(),
          );
          const participantIds = participants.map((row) => row.id);
          if (participantIds.length < 2)
            throw new Error(`Contest participants missing for ${profile.key}`);

          await expect(
            submitContestResult(actor, contest.id, {
              expectedVersion: contest.version,
              result: invalidInput(format, participantIds[0] ?? ''),
              finalize: true,
            }),
            `${profile.key} format ${format.format} accepted invalid input`,
          ).rejects.toThrow();

          const submitted = await submitContestResult(actor, contest.id, {
            expectedVersion: contest.version,
            result: validEntries(format, participantIds),
            finalize: true,
          });
          expect(submitted.status).toBe('final');
          checked += 1;
        }
      }
      expect(checked).toBe(50);
    },
  );
});
