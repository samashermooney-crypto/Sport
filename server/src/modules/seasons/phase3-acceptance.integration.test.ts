import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplatesByKey } from '@shared/sport/templates';
import type { NextFunction, Request, Response } from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB, Json } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { idempotentRoute } from '../../lib/idempotency';
import { OfferingsService } from '../offerings/service';
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
  it('creates a manually named persistent team in its selected program', async () => {
    const created = await new TeamsService(database, context).createForProgram({
      team: {
        name: `Manual ${randomUUID().slice(0, 8)}`,
        sportProfileId: profileId,
      },
      programId,
      divisionId,
    });

    expect(created.team.sport_profile_id).toBe(profileId);
    expect(created.season.program_id).toBe(programId);
    expect(created.season.division_id).toBe(divisionId);
    await expect(
      new TeamsService(database, context).list(programId),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: created.season.id,
        team_id: created.team.id,
      }),
    );
  });

  it('preserves registration wall time when an offset crosses daylight saving time', async () => {
    await withOrg()(context, (trx) =>
      trx
        .updateTable('organizations')
        .set({ timezone: 'America/Chicago' })
        .where('id', '=', context.orgId)
        .execute(),
    );
    const seasons = new SeasonsService(database, context);
    const programs = new ProgramsService(database, context);
    const spring = await seasons.create({
      name: 'Spring 2027',
      startsOn: '2027-03-01',
      endsOn: '2027-03-20',
    });
    const source = await programs.create({
      seasonId: spring.id,
      sportProfileId: profileId,
      mode: 'league',
      name: 'Spring Soccer',
      slug: `dst-${randomUUID().slice(0, 8)}`,
      startsOn: '2027-03-01',
      endsOn: '2027-03-20',
    });
    await withOrg()(context, (trx) =>
      trx
        .updateTable('programs')
        .set({ registration_opens_at: new Date('2027-03-13T15:00:00.000Z') })
        .where('org_id', '=', context.orgId)
        .where('id', '=', source.id)
        .execute(),
    );

    const copy = await (async () => {
      try {
        return await withOrg()(context, (trx) =>
          seasons.rolloverInTransaction(trx, spring.id, {
            name: 'Spring 2028',
            startsOn: '2028-03-01',
            endsOn: '2028-03-20',
            offsetDays: 1,
            returningTeamSeasonIds: [],
            carryStaffIds: [],
          }),
        );
      } finally {
        await withOrg()(context, (trx) =>
          trx
            .updateTable('organizations')
            .set({ timezone: 'UTC' })
            .where('id', '=', context.orgId)
            .execute(),
        );
      }
    })();
    const copied = await withOrg()(context, (trx) =>
      trx
        .selectFrom('programs')
        .select('registration_opens_at')
        .where('org_id', '=', context.orgId)
        .where('season_id', '=', copy.season.id)
        .where('copied_from_program_id', '=', source.id)
        .executeTakeFirstOrThrow(),
    );
    expect(copied.registration_opens_at?.toISOString()).toBe(
      '2027-03-14T14:00:00.000Z',
    );
  });

  it('maps program dates through an explicit date map and invokes extras', async () => {
    const captured: RolloverIdMap[] = [];
    const seasons = new SeasonsService(database, context, [
      (_trx: OrgTransaction, ids: RolloverIdMap) => {
        captured.push(ids);
        return Promise.resolve();
      },
    ]);
    const programs = new ProgramsService(database, context);
    const offerings = new OfferingsService(database, context);
    const sourceOffering = await offerings.create({
      programId,
      divisionId,
      name: 'Season registration',
      registrantRole: 'athlete',
      priceCents: 12500,
      pricing: {
        earlyPriceCents: 11000,
        earlyEndsAt: '2026-11-15T23:59:00-06:00',
        latePriceCents: 13500,
        lateStartsAt: '2026-11-16T00:00:00-06:00',
        installmentTemplateIds: [],
        siblingDiscountEligible: false,
        glCode: 'REG',
      },
      addOns: [
        {
          key: 'uniform-kit',
          name: 'Uniform kit',
          priceCents: 2500,
          required: true,
          options: [{ key: 'youth-small', label: 'Youth small' }],
        },
      ],
      formDefinitionIds: [],
      waiverDocumentIds: [],
      active: true,
    });
    await withOrg()(context, (trx) =>
      trx
        .updateTable('organizations')
        .set({ timezone: 'America/Chicago' })
        .where('id', '=', context.orgId)
        .execute(),
    );
    const rolloverInput = {
      name: 'Fall 2027',
      startsOn: '2027-09-01',
      endsOn: '2027-12-15',
      offsetDays: 365,
      dateMap: {
        '2026-09-10': '2027-09-20',
        '2026-12-01': '2027-12-10',
      },
      returningTeamSeasonIds: [teamSeasonId],
      carryStaffIds: [],
    };
    const preview = await seasons.preview(sourceSeason, rolloverInput);
    const previewProgram = preview.programs.find(
      (item) => item.id === programId,
    );
    if (!previewProgram)
      throw new Error('Program missing from rollover preview');
    expect(
      previewProgram.divisions.some((division) => division.name.length > 0),
    ).toBe(true);
    const previewOffering = previewProgram.offerings.at(0);
    expect(previewOffering?.name).toBe('Season registration');
    expect(previewOffering?.priceCents).toBe(12500);
    expect(previewOffering?.addOnCount).toBe(1);
    const copy = await (async () => {
      try {
        return await withOrg()(context, (trx) =>
          seasons.rolloverInTransaction(trx, sourceSeason, rolloverInput),
        );
      } finally {
        await withOrg()(context, (trx) =>
          trx
            .updateTable('organizations')
            .set({ timezone: 'UTC' })
            .where('id', '=', context.orgId)
            .execute(),
        );
      }
    })();
    const next = await programs.list(copy.season.id);
    expect(next).toHaveLength(1);
    const copied = next.at(0);
    if (!copied) throw new Error('Copied program missing');
    expect(copied.starts_on.toISOString().slice(0, 10)).toBe('2027-09-20');
    expect(copied.ends_on.toISOString().slice(0, 10)).toBe('2027-12-10');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.seasonId).toBe(copy.season.id);
    expect(captured[0]?.programIds.size).toBe(1);
    expect(captured[0]?.offeringIds.has(sourceOffering.id)).toBe(true);
    expect(captured[0]?.teamSeasonIds.size).toBe(1);
    expect(captured[0]?.dateShift.offsetDays).toBe(365);
    expect(captured[0]?.dateShift.timeZone).toBe('America/Chicago');
    expect(captured[0]?.dateShift.shiftDate(new Date(2026, 11, 1))).toBe(
      '2027-12-10',
    );
    expect(
      captured[0]?.dateShift
        .shiftInstant(new Date('2026-11-15T23:59:00-06:00'))
        ?.toISOString(),
    ).toBe('2027-11-16T05:59:00.000Z');
    const copiedDetail = await programs.get(copied.id);
    expect(copiedDetail.offerings).toHaveLength(1);
    expect(copiedDetail.offerings[0]).toMatchObject({
      name: sourceOffering.name,
      price_cents: sourceOffering.price_cents,
      pricing: {
        earlyPriceCents: 11000,
        installmentTemplateIds: [],
        siblingDiscountEligible: false,
        glCode: 'REG',
      },
      add_ons: [
        {
          key: 'uniform-kit',
          name: 'Uniform kit',
          priceCents: 2500,
          required: true,
          options: [{ key: 'youth-small', label: 'Youth small' }],
        },
      ],
      form_definition_ids: [],
      waiver_document_ids: [],
      active: false,
    });
    const copiedPricing = copiedDetail.offerings[0]?.pricing as {
      earlyEndsAt?: string;
      lateStartsAt?: string;
    };
    expect(copiedPricing.earlyEndsAt).toBe('2027-11-16T05:59:00.000Z');
    expect(copiedPricing.lateStartsAt).toBe('2027-11-16T06:00:00.000Z');
    const copiedRegistrations = await withOrg()(context, (trx) =>
      trx
        .selectFrom('registrations')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('program_id', '=', copied.id)
        .execute(),
    );
    expect(copiedRegistrations).toHaveLength(0);
  });

  it('creates one copy when the same rollover idempotency key is replayed', async () => {
    const name = `Idempotent ${randomUUID().slice(0, 8)}`;
    const input = {
      name,
      startsOn: '2029-09-01',
      endsOn: '2029-12-15',
      offsetDays: 365,
      returningTeamSeasonIds: [],
      carryStaffIds: [],
    };
    const idempotencyKey = randomUUID();
    const handler = idempotentRoute({
      context: () => context,
      runWithOrg: createWithOrg(database),
      execute: async (_request, trx) => {
        const result = await new SeasonsService(
          database,
          context,
        ).rolloverInTransaction(trx, sourceSeason, input);
        return {
          status: 201,
          body: JSON.parse(JSON.stringify(result)) as unknown,
        };
      },
    });
    const call = () =>
      new Promise<{
        status: number;
        body: unknown;
        headers: Record<string, string>;
      }>((resolve, reject) => {
        let status = 200;
        const headers: Record<string, string> = {};
        const request = {
          method: 'POST',
          originalUrl: `/api/v1/seasons/orgs/${context.orgId}/${sourceSeason}/rollover`,
          path: `/orgs/${context.orgId}/${sourceSeason}/rollover`,
          body: input,
          get: (header: string) =>
            header === 'Idempotency-Key' ? idempotencyKey : undefined,
        } as unknown as Request;
        const response = {
          status(code: number) {
            status = code;
            return this;
          },
          setHeader(header: string, value: string) {
            headers[header] = value;
            return this;
          },
          json(body: unknown) {
            resolve({ status, body, headers });
            return this;
          },
        } as unknown as Response;
        handler(request, response, reject as NextFunction);
      });
    const first = await call();
    const replay = await call();
    expect(first.status).toBe(201);
    expect(replay).toMatchObject({
      status: first.status,
      body: first.body,
      headers: { 'Idempotent-Replayed': 'true' },
    });
    expect(
      (first.body as { season: { starts_on: unknown } }).season.starts_on,
    ).toBeTypeOf('string');
    const copies = await withOrg()(context, (trx) =>
      trx
        .selectFrom('seasons')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('copied_from_season_id', '=', sourceSeason)
        .where('name', '=', name)
        .execute(),
    );
    expect(copies).toHaveLength(1);
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

  it('rejects duplicate rollover selections before creating a second copy', async () => {
    await expect(
      withOrg()(context, (trx) =>
        new SeasonsService(database, context).rolloverInTransaction(
          trx,
          sourceSeason,
          {
            name: `Duplicate selection ${randomUUID().slice(0, 8)}`,
            startsOn: '2028-09-01',
            endsOn: '2028-12-15',
            offsetDays: 365,
            returningTeamSeasonIds: [teamSeasonId, teamSeasonId],
            carryStaffIds: [],
          },
        ),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'A returning team can only be selected once',
    });
  });
});

describe('roster invariants', () => {
  it('serializes concurrent adds against the roster limit', async () => {
    const teams = new TeamsService(database, context);
    const generated = await teams.generate({
      programId,
      divisionId,
      count: 1,
      pattern: `Limited ${randomUUID().slice(0, 6)} {n}`,
    });
    const limitedTeam = generated[0]?.season;
    if (!limitedTeam) throw new Error('Limited team season unavailable');
    await teams.updateTeamSeason(limitedTeam.id, {
      expectedVersion: limitedTeam.version,
      rosterLimit: 1,
    });
    const rosters = new RostersService(database, context);
    const [first, second] = await Promise.all([
      addPerson('At capacity one'),
      addPerson('At capacity two'),
    ]);
    const results = await Promise.allSettled([
      rosters.add(limitedTeam.id, { personId: first }),
      rosters.add(limitedTeam.id, { personId: second }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected')
      expect(rejected.reason).toMatchObject({
        status: 409,
        code: 'CAPACITY_FULL',
      });
  });

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
