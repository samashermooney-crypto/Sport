import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplatesByKey } from '@shared/sport/templates';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB, Json } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { ProgramsService } from '../programs/service';
import { RostersService, RosterError } from '../rosters/service';
import { TeamsService } from '../teams/service';

import { SeasonsService, type RolloverIdMap } from './service';

let database: Kysely<DB>;
let context: OrgContext;
let profileId: string;
let programId: string;
let divisionId: string;
let teamSeasonId: string;
let sourceSeason: string;

const withOrg = () => createWithOrg(database);

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `phase3-accept-${randomUUID()}@example.invalid`,
      first_name: 'Phase',
      last_name: 'Acceptance',
      date_of_birth: '1980-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `phase3-accept-${randomUUID().slice(0, 12)}`,
      name: 'Phase 3 Acceptance',
      kind: 'club',
      timezone: 'UTC',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  profileId = newId();
  await withOrg()(context, async (trx) => {
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
    const profile = builtInSportTemplatesByKey.get('soccer');
    if (!profile) throw new Error('Soccer template unavailable');
    await trx
      .insertInto('sport_profiles')
      .values({
        id: profileId,
        org_id: orgId,
        template_key: null,
        name: profile.name.en,
        profile: profile as Json,
      })
      .execute();
  });
  const seasons = new SeasonsService(database, context);
  const programs = new ProgramsService(database, context);
  const teams = new TeamsService(database, context);
  const season = await seasons.create({
    name: 'Fall 2026',
    startsOn: '2026-09-01',
    endsOn: '2026-12-15',
  });
  const program = await programs.create({
    seasonId: season.id,
    sportProfileId: profileId,
    mode: 'league',
    name: 'Soccer',
    slug: `accept-${randomUUID().slice(0, 8)}`,
    startsOn: '2026-09-10',
    endsOn: '2026-12-01',
  });
  programId = program.id;
  const detail = await programs.get(program.id);
  divisionId = detail.divisions[0]?.id ?? '';
  const generated = await teams.generate({
    programId,
    divisionId,
    count: 2,
    pattern: 'Accept {n}',
  });
  const first = generated[0];
  if (!first) throw new Error('Team generation failed');
  teamSeasonId = first.season.id;
  sourceSeason = season.id;
});

afterAll(async () => {
  await database.destroy();
});

const addPerson = async (firstName: string, dateOfBirth = '2014-05-01') => {
  const id = newId();
  await withOrg()(context, (trx) =>
    trx
      .insertInto('people')
      .values({
        id,
        org_id: context.orgId,
        first_name: firstName,
        last_name: 'Athlete',
        date_of_birth: dateOfBirth,
      })
      .execute(),
  );
  return id;
};

describe('season rollover acceptance', () => {
  it('maps program dates through an explicit date map and invokes extras', async () => {
    const captured: RolloverIdMap[] = [];
    const seasons = new SeasonsService(database, context, [
      (_trx: OrgTransaction, ids: RolloverIdMap) => {
        captured.push(ids);
        return Promise.resolve();
      },
    ]);
    const programs = new ProgramsService(database, context);
    const copy = await withOrg()(context, (trx) =>
      seasons.rolloverInTransaction(trx, sourceSeason, {
        name: 'Fall 2027',
        startsOn: '2027-09-01',
        endsOn: '2027-12-15',
        offsetDays: 0,
        dateMap: { '2026-09-10': '2027-09-20', '2026-12-01': '2027-12-10' },
        returningTeamSeasonIds: [teamSeasonId],
        carryStaffIds: [],
      }),
    );
    const next = await programs.list(copy.season.id);
    expect(next).toHaveLength(1);
    const copied = next.at(0);
    if (!copied) throw new Error('Copied program missing');
    expect(copied.starts_on.toISOString().slice(0, 10)).toBe('2027-09-20');
    expect(copied.ends_on.toISOString().slice(0, 10)).toBe('2027-12-10');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.seasonId).toBe(copy.season.id);
    expect(captured[0]?.programIds.size).toBe(1);
    expect(captured[0]?.teamSeasonIds.size).toBe(1);
  });

  it('carries selected staff into the new season as pending compliance', async () => {
    const seasons = new SeasonsService(database, context);
    const teams = new TeamsService(database, context);
    const coachId = await addPerson('Carry', '1985-02-02');
    const staff = await teams.assignStaff(teamSeasonId, {
      personId: coachId,
      role: 'other',
    });
    expect(staff.status).toBe('active');
    const copy = await withOrg()(context, (trx) =>
      seasons.rolloverInTransaction(trx, sourceSeason, {
        name: 'Winter 2028',
        startsOn: '2028-01-05',
        endsOn: '2028-04-01',
        offsetDays: 450,
        returningTeamSeasonIds: [teamSeasonId],
        carryStaffIds: [staff.id],
      }),
    );
    expect(copy.copied).toMatchObject({ teams: 1, staff: 1 });
    const staffRows = await withOrg()(context, (trx) =>
      trx
        .selectFrom('team_staff as s')
        .innerJoin('team_seasons as ts', 'ts.id', 's.team_season_id')
        .innerJoin('programs as p', 'p.id', 'ts.program_id')
        .select(['s.status', 's.person_id', 's.role'])
        .where('s.org_id', '=', context.orgId)
        .where('p.season_id', '=', copy.season.id)
        .execute(),
    );
    expect(staffRows).toMatchObject([
      { person_id: coachId, role: 'other', status: 'pending_compliance' },
    ]);
  });
});

describe('roster invariants', () => {
  it('rejects duplicate jersey numbers under concurrent writes', async () => {
    const rosters = new RostersService(database, context);
    const [first, second] = await Promise.all([
      addPerson('One'),
      addPerson('Two'),
    ]);
    const results = await Promise.allSettled([
      rosters.add(teamSeasonId, { personId: first, jerseyNumber: '7' }),
      rosters.add(teamSeasonId, { personId: second, jerseyNumber: '7' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(RosterError);
    expect((rejected[0]?.reason as RosterError).status).toBe(409);
  });

  it('rejects the same person on one roster twice', async () => {
    const rosters = new RostersService(database, context);
    const person = await addPerson('Duplicate');
    await rosters.add(teamSeasonId, { personId: person, jerseyNumber: '11' });
    await expect(
      rosters.add(teamSeasonId, { personId: person, jerseyNumber: '12' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('staff compliance gating', () => {
  it('assigns pending_compliance without credentials and activates after verification', async () => {
    const teams = new TeamsService(database, context);
    const credentialTypeId = newId();
    await withOrg()(context, async (trx) => {
      await trx
        .insertInto('credential_types')
        .values({
          id: credentialTypeId,
          org_id: context.orgId,
          key: `background_check_${randomUUID().slice(0, 8)}`,
          name: 'Background check',
          verification: 'manual_staff',
          validity: {} as Json,
          applies_to: { roles: ['head_coach'] } as Json,
          blocks_activation: true,
        })
        .execute();
      await trx
        .insertInto('role_credential_requirements')
        .values({
          id: newId(),
          org_id: context.orgId,
          role: 'head_coach',
          credential_type_id: credentialTypeId,
          scope_type: 'org',
        })
        .execute();
    });
    const coachId = await addPerson('Gated', '1985-02-02');
    const assigned = await teams.assignStaff(teamSeasonId, {
      personId: coachId,
      role: 'head_coach',
    });
    expect(assigned.status).toBe('pending_compliance');
    await withOrg()(context, (trx) =>
      trx
        .insertInto('person_credentials')
        .values({
          id: newId(),
          org_id: context.orgId,
          person_id: coachId,
          credential_type_id: credentialTypeId,
          status: 'verified',
          verified_by: context.actor.accountId,
          verified_at: new Date(),
        })
        .execute(),
    );
    const revalidated = await teams.revalidateStaff(assigned.id);
    expect(revalidated.status).toBe('active');
    const listed = await teams.listStaff(teamSeasonId);
    expect(listed.some((row) => row.id === assigned.id)).toBe(true);
    await teams.removeStaff(assigned.id, revalidated.version);
    await expect(teams.revalidateStaff(assigned.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('enforces team season status transitions and optimistic versions', async () => {
    const teams = new TeamsService(database, context);
    const generated = await teams.generate({
      programId,
      divisionId,
      count: 1,
      pattern: 'Gate {n}',
    });
    const season = generated[0]?.season;
    if (!season) throw new Error('Team season unavailable');
    await expect(
      teams.updateTeamSeason(season.id, {
        expectedVersion: season.version,
        status: 'completed',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    const activated = await teams.updateTeamSeason(season.id, {
      expectedVersion: season.version,
      status: 'active',
    });
    expect(activated.status).toBe('active');
    await expect(
      teams.updateTeamSeason(season.id, {
        expectedVersion: season.version,
        status: 'completed',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const completed = await teams.updateTeamSeason(season.id, {
      expectedVersion: activated.version,
      status: 'completed',
    });
    expect(completed.status).toBe('completed');
    await expect(
      teams.updateTeamSeason(season.id, {
        expectedVersion: completed.version,
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
