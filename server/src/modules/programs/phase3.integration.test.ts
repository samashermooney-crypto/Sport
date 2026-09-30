import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplatesByKey } from '@shared/sport/templates';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB, Json } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { PostgresInstallmentTemplates } from '../finance/installment-templates';
import { OfferingsService } from '../offerings/service';
import { SeasonsService } from '../seasons/service';
import { TeamsService } from '../teams/service';

import { ProgramsService } from './service';

let database: Kysely<DB>;
let context: OrgContext;
let profileId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `phase3-${randomUUID()}@example.invalid`,
      first_name: 'Phase',
      last_name: 'Three',
      date_of_birth: '1980-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `phase3-${randomUUID().slice(0, 12)}`,
      name: 'Phase 3 Test',
      kind: 'club',
      timezone: 'UTC',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  profileId = newId();
  await createWithOrg(database)(context, async (trx) => {
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
});
afterAll(async () => {
  await database.destroy();
});

describe('Phase 3 structure and rollover', () => {
  it('connects active finance plans to offerings and preserves capacity/version guards', async () => {
    const seasons = new SeasonsService(database, context);
    const programs = new ProgramsService(database, context);
    const offerings = new OfferingsService(database, context);
    const plans = new PostgresInstallmentTemplates(database, context);
    const season = await seasons.create({
      name: 'Picker season',
      startsOn: '2027-01-01',
      endsOn: '2027-06-30',
    });
    const program = await programs.create({
      seasonId: season.id,
      sportProfileId: profileId,
      mode: 'league',
      name: 'Picker league',
      slug: `picker-${randomUUID().slice(0, 8)}`,
      startsOn: '2027-02-01',
      endsOn: '2027-05-01',
    });
    const templateInput = {
      deposit: { kind: 'fixed' as const, amountCents: 0 },
      schedule: { kind: 'weekly' as const, count: 4 },
      minAmountCents: 100,
      autopayRequired: false,
      allowedMethods: ['card' as const],
    };
    const activePlan = await plans.create({
      ...templateInput,
      name: `Active weekly ${randomUUID().slice(0, 8)}`,
    });
    const archivedPlan = await plans.create({
      ...templateInput,
      name: `Archived weekly ${randomUUID().slice(0, 8)}`,
    });
    await plans.archive(archivedPlan.id, archivedPlan.version);

    expect(await offerings.templates()).toEqual([activePlan]);
    const offering = await offerings.create({
      programId: program.id,
      name: 'Volleyball registration',
      registrantRole: 'athlete',
      priceCents: 12000,
      capacity: 2,
      pricing: {
        installmentTemplateIds: [activePlan.id],
        siblingDiscountEligible: true,
        glCode: null,
      },
      active: true,
    });
    expect(offering.pricing).toMatchObject({
      installmentTemplateIds: [activePlan.id],
    });
    await expect(
      offerings.create({
        programId: program.id,
        name: 'Archived plan registration',
        registrantRole: 'athlete',
        priceCents: 12000,
        pricing: {
          installmentTemplateIds: [archivedPlan.id],
          siblingDiscountEligible: true,
          glCode: null,
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });

    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('capacity_counters')
        .set({ confirmed: 1, held: 1 })
        .where('org_id', '=', context.orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', offering.id)
        .execute(),
    );
    await expect(
      offerings.update(offering.id, {
        expectedVersion: offering.version,
        capacity: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    const updated = await offerings.update(offering.id, {
      expectedVersion: offering.version,
      capacity: 3,
      name: 'Volleyball registration updated',
    });
    expect(updated).toMatchObject({ version: 2, capacity: 3 });
    await expect(
      offerings.update(offering.id, {
        expectedVersion: offering.version,
        name: 'Stale write',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });

  it('gives every program, division and offering a capacity counter so family checkout can hold places', async () => {
    const seasons = new SeasonsService(database, context);
    const programs = new ProgramsService(database, context);
    const offerings = new OfferingsService(database, context);
    const season = await seasons.create({
      name: 'Counter season',
      startsOn: '2027-01-01',
      endsOn: '2027-06-30',
    });
    const program = await programs.create({
      seasonId: season.id,
      sportProfileId: profileId,
      mode: 'league',
      name: 'Counter league',
      slug: `counter-${randomUUID().slice(0, 8)}`,
      startsOn: '2027-02-01',
      endsOn: '2027-05-01',
    });
    const division = await programs.addDivision(program.id, {
      name: 'U10 girls',
      capacityPlayers: 12,
    });
    const offering = await offerings.create({
      programId: program.id,
      divisionId: division.id,
      name: 'U10 girls registration',
      registrantRole: 'athlete',
      priceCents: 0,
      capacity: 10,
    });
    const counters = () =>
      createWithOrg(database)(context, (trx) =>
        trx
          .selectFrom('capacity_counters')
          .select(['subject_type', 'subject_id', 'capacity', 'held'])
          .where('org_id', '=', context.orgId)
          .where('subject_id', 'in', [program.id, division.id, offering.id])
          .orderBy('subject_type')
          .execute(),
      );
    expect(await counters()).toEqual([
      {
        subject_type: 'division',
        subject_id: division.id,
        capacity: 12,
        held: 0,
      },
      {
        subject_type: 'offering',
        subject_id: offering.id,
        capacity: 10,
        held: 0,
      },
      {
        subject_type: 'program',
        subject_id: program.id,
        capacity: null,
        held: 0,
      },
    ]);

    await createWithOrg(database)(context, async (trx) => {
      await trx
        .updateTable('capacity_counters')
        .set({ held: 5 })
        .where('org_id', '=', context.orgId)
        .where('subject_type', '=', 'division')
        .where('subject_id', '=', division.id)
        .execute();
      await trx
        .updateTable('divisions')
        .set({ capacity_players: 8 })
        .where('org_id', '=', context.orgId)
        .where('id', '=', division.id)
        .execute();
    });
    expect((await counters())[0]).toMatchObject({ capacity: 8, held: 5 });
    await expect(
      createWithOrg(database)(context, (trx) =>
        trx
          .updateTable('divisions')
          .set({ capacity_players: 4 })
          .where('org_id', '=', context.orgId)
          .where('id', '=', division.id)
          .execute(),
      ),
    ).rejects.toThrow('Capacity cannot fall below confirmed and held places');
  });

  it('creates default division, 18 soccer divisions, offering, teams and one clean season copy', async () => {
    const seasons = new SeasonsService(database, context);
    const programs = new ProgramsService(database, context);
    const offerings = new OfferingsService(database, context);
    const teams = new TeamsService(database, context);
    const source = await seasons.create({
      name: 'Spring 2026',
      startsOn: '2026-03-01',
      endsOn: '2026-06-30',
    });
    const program = await programs.create({
      seasonId: source.id,
      sportProfileId: profileId,
      mode: 'league',
      name: 'Soccer',
      slug: `soccer-${randomUUID().slice(0, 8)}`,
      startsOn: '2026-03-15',
      endsOn: '2026-06-15',
    });
    expect((await programs.get(program.id)).divisions).toMatchObject([
      { is_default: true, name: 'All participants' },
    ]);
    const divisions = await programs.generate(program.id, {
      method: 'birth_year',
      from: 6,
      to: 14,
      genders: ['boys', 'girls'],
    });
    expect(divisions).toHaveLength(18);
    const current = await programs.get(program.id);
    expect(
      current.divisions.filter((division) => division.is_default),
    ).toHaveLength(1);
    expect(current.divisions).toHaveLength(18);
    const division = divisions[0];
    if (!division) throw new Error('Division unavailable');
    await offerings.create({
      programId: program.id,
      divisionId: division.id,
      name: 'Player',
      registrantRole: 'athlete',
      priceCents: 7500,
      pricing: {
        installmentTemplateIds: [],
        siblingDiscountEligible: true,
        glCode: null,
      },
    });
    const generated = await teams.generate({
      programId: program.id,
      divisionId: division.id,
      count: 2,
      pattern: 'Soccer {n}',
    });
    expect(generated).toHaveLength(2);
    const roster = generated[0];
    if (!roster) throw new Error('Team unavailable');
    const input = {
      name: 'Spring 2027',
      startsOn: '2027-03-01',
      endsOn: '2027-06-30',
      offsetDays: 365,
      returningTeamSeasonIds: [roster.season.id],
      carryStaffIds: [],
    };
    const preview = await seasons.preview(source.id, input);
    expect(preview.teams.filter((team) => team.returning)).toHaveLength(1);
    const copy = await createWithOrg(database)(context, (trx) =>
      seasons.rolloverInTransaction(trx, source.id, input),
    );
    expect(copy.copied).toMatchObject({ programs: 1, teams: 1, staff: 0 });
    const next = await programs.list({ seasonId: copy.season.id });
    expect(next).toHaveLength(1);
    expect((await programs.get(next[0]?.id ?? '')).offerings).toHaveLength(1);
    expect(await teams.list(next[0]?.id)).toMatchObject([
      { status: 'forming' },
    ]);
    const copiedRegistrations = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('registrations')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('program_id', '=', next[0]?.id ?? '')
        .execute(),
    );
    expect(copiedRegistrations).toHaveLength(0);

    const classProgram = await programs.create({
      seasonId: source.id,
      sportProfileId: profileId,
      mode: 'class',
      name: 'Gymnastics Academy',
      slug: `academy-${randomUUID().slice(0, 8)}`,
      startsOn: '2026-03-15',
      endsOn: '2026-06-15',
    });
    await programs.setStatus(
      classProgram.id,
      'published',
      classProgram.version,
    );
    expect(
      await programs.list({
        seasonId: source.id,
        mode: 'class',
        status: 'published',
      }),
    ).toMatchObject([
      { id: classProgram.id, mode: 'class', status: 'published' },
    ]);
  });
});
