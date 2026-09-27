import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import type { Kysely } from 'kysely';

import type { DB } from '../../server/src/db/types';
import { createWithOrg } from '../../server/src/db/withOrg';
import { hashPassword } from '../../server/src/modules/auth/password';

function stableId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-7${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const FIRST = [
  'Amelia', 'Mateo', 'Sofia', 'Liam', 'Isabella', 'Noah', 'Maya', 'Ethan',
  'Chloe', 'Lucas', 'Zoe', 'Owen', 'Ruby', 'Caleb', 'Nora', 'Jonah',
  'Elena', 'Marcus', 'Ivy', 'Dante', 'Hazel', 'Silas', 'Vera', 'Oscar',
];
const LAST = [
  'Reyes', 'Nguyen', 'Okafor', 'Larsen', 'Delgado', 'Kim', 'Patel',
  'Johnson', 'Morales', 'Fischer', 'Abara', 'Sullivan', 'Torres', 'Webb',
];

function template(key: string) {
  const found = builtInSportTemplates.find((item) => item.key === key);
  if (!found) throw new Error(`Missing sport template ${key}`);
  return found;
}

interface OrgSpec {
  seed: string;
  slug: string;
  name: string;
  kind: string;
  timezone: string;
  sportKey: string;
  sportName: string;
  city: string;
  facilityNames: string[];
  programs: { name: string; mode: string; price: number; open: boolean }[];
  teamNames: string[];
  households: number;
}

const ORGS: OrgSpec[] = [
  {
    seed: 'riverbend',
    slug: 'riverbend-soccer',
    name: 'Riverbend Youth Soccer League',
    kind: 'league',
    timezone: 'America/Chicago',
    sportKey: 'soccer',
    sportName: 'Soccer',
    city: 'Naperville, IL',
    facilityNames: ['Riverbend Park Field 1', 'Riverbend Park Field 2'],
    programs: [
      { name: 'Spring Rec League', mode: 'league', price: 14500, open: true },
      { name: 'Summer Camp', mode: 'camp', price: 22000, open: true },
    ],
    teamNames: ['U10 Foxes', 'U10 Otters', 'U12 Herons', 'U12 Badgers'],
    households: 10,
  },
  {
    seed: 'cascade',
    slug: 'cascade-volleyball',
    name: 'Cascade Volleyball Club',
    kind: 'club',
    timezone: 'America/Los_Angeles',
    sportKey: 'volleyball',
    sportName: 'Volleyball',
    city: 'Bellevue, WA',
    facilityNames: ['Cascade Fieldhouse Court A', 'Cascade Fieldhouse Court B'],
    programs: [
      { name: 'Club Season 2026', mode: 'club', price: 185000, open: true },
    ],
    teamNames: ['14U Storm', '16U Summit'],
    households: 8,
  },
  {
    seed: 'sunrise',
    slug: 'sunrise-swim',
    name: 'Sunrise Swim Academy',
    kind: 'academy',
    timezone: 'America/Phoenix',
    sportKey: 'swimming',
    sportName: 'Swimming',
    city: 'Scottsdale, AZ',
    facilityNames: ['Sunrise Aquatic Center'],
    programs: [
      { name: 'Learn-to-Swim Session 3', mode: 'class', price: 9600, open: true },
    ],
    teamNames: [],
    households: 8,
  },
  {
    seed: 'ironpeak',
    slug: 'ironpeak-tournaments',
    name: 'Iron Peak Basketball Tournaments',
    kind: 'tournament_operator',
    timezone: 'America/Denver',
    sportKey: 'basketball',
    sportName: 'Basketball',
    city: 'Aurora, CO',
    facilityNames: ['Iron Peak Arena Court 1', 'Iron Peak Arena Court 2'],
    programs: [
      {
        name: 'Rocky Mountain Classic',
        mode: 'tournament',
        price: 47500,
        open: true,
      },
    ],
    teamNames: ['Eastside Elite', 'Front Range Flight', 'Summit Select'],
    households: 6,
  },
  {
    seed: 'maplegrove',
    slug: 'maple-grove-rec',
    name: 'Maple Grove Parks & Recreation',
    kind: 'parks_rec',
    timezone: 'America/Chicago',
    sportKey: 'flag_football',
    sportName: 'Flag Football',
    city: 'Maple Grove, MN',
    facilityNames: ['Central Park West Field', 'Community Gym'],
    programs: [
      { name: 'Fall Flag Football', mode: 'league', price: 9800, open: true },
      { name: 'Youth Open Gym', mode: 'class', price: 4000, open: false },
    ],
    teamNames: ['Crimson Hawks', 'Maple Wolves'],
    households: 8,
  },
  {
    seed: 'pnwhockey',
    slug: 'pnw-hockey',
    name: 'Pacific Northwest Hockey Association',
    kind: 'association',
    timezone: 'America/Los_Angeles',
    sportKey: 'ice_hockey',
    sportName: 'Ice Hockey',
    city: 'Beaverton, OR',
    facilityNames: ['PNW Ice Center Rink A'],
    programs: [
      { name: 'Winter Season 2026-27', mode: 'league', price: 89000, open: true },
    ],
    teamNames: ['Squirt Blades', 'Peewee Pucks', 'Bantam Breakers'],
    households: 8,
  },
];

export async function seedDemo(database: Kysely<DB>): Promise<void> {
  const passwordHash = await hashPassword('Athlentry-Demo-2026!');
  for (const spec of ORGS) {
    const orgId = stableId(`demo-org-${spec.seed}`);
    const adminId = stableId(`demo-admin-${spec.seed}`);
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: spec.slug,
        name: spec.name,
        kind: spec.kind,
        timezone: spec.timezone,
        email: `hello@${spec.slug}.demo.athlentry.invalid`,
        status: 'active',
        website_url: `https://${spec.slug}.demo.athlentry.invalid`,
        nonprofit: spec.kind === 'league' || spec.kind === 'parks_rec',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await database
      .insertInto('accounts')
      .values({
        id: adminId,
        email: `admin@${spec.slug}.demo.athlentry.invalid`,
        first_name: 'Dana',
        last_name: 'Admin',
        date_of_birth: '1985-04-12',
        password_hash: passwordHash,
        email_verified_at: new Date(),
        locale: spec.seed === 'sunrise' ? 'es' : 'en',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await database
      .insertInto('accounts')
      .values({
        id: stableId(`demo-parent-${spec.seed}`),
        email: `parent@${spec.slug}.demo.athlentry.invalid`,
        first_name: 'Pat',
        last_name: 'Parent',
        date_of_birth: '1988-09-02',
        password_hash: passwordHash,
        email_verified_at: new Date(),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    const withOrg = createWithOrg(database);
    const context = { orgId, actor: { accountId: adminId } };
    await withOrg(context, async (trx) => {
      const existingMembership = await trx
        .selectFrom('org_memberships')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', adminId)
        .executeTakeFirst();
      if (!existingMembership) {
        await trx
          .insertInto('org_memberships')
          .values({
            id: stableId(`demo-member-${spec.seed}`),
            org_id: orgId,
            account_id: adminId,
            status: 'active',
            title: 'Administrator',
            joined_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('role_assignments')
          .values({
            id: stableId(`demo-role-${spec.seed}`),
            org_id: orgId,
            account_id: adminId,
            role: 'owner',
            scope_type: 'org',
            granted_by: adminId,
          })
          .execute();
      }
      const sportProfileId = stableId(`demo-sport-${spec.seed}`);
      const seasonId = stableId(`demo-season-${spec.seed}`);
      const existingProfile = await trx
        .selectFrom('sport_profiles')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', sportProfileId)
        .executeTakeFirst();
      if (existingProfile) return;
      await trx
        .insertInto('sport_profiles')
        .values({
          id: sportProfileId,
          org_id: orgId,
          name: spec.sportName,
          profile: JSON.parse(
            JSON.stringify(template(spec.sportKey)),
          ) as never,
        })
        .execute();
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Spring 2026',
          starts_on: '2026-03-01',
          ends_on: '2026-06-30',
        })
        .execute();
      for (const [index, facilityName] of spec.facilityNames.entries()) {
        await trx
          .insertInto('facilities')
          .values({
            id: stableId(`demo-facility-${spec.seed}-${String(index)}`),
            org_id: orgId,
            name: facilityName,
            ownership: spec.kind === 'parks_rec' ? 'owned' : 'permitted',
            address: JSON.parse(
              JSON.stringify({
                line1: '1 Demo Way',
                city: spec.city,
                state: spec.city.split(', ')[1] ?? 'IL',
                postalCode: '60000',
              }),
            ) as never,
            public: true,
          })
          .execute();
      }
      for (const [index, program] of spec.programs.entries()) {
        const programId = stableId(`demo-program-${spec.seed}-${String(index)}`);
        const divisionId = stableId(
          `demo-division-${spec.seed}-${String(index)}`,
        );
        const offeringId = stableId(
          `demo-offering-${spec.seed}-${String(index)}`,
        );
        await trx
          .insertInto('programs')
          .values({
            id: programId,
            org_id: orgId,
            season_id: seasonId,
            sport_profile_id: sportProfileId,
            mode: program.mode,
            name: program.name,
            slug: `${spec.slug}-p${String(index)}`,
            starts_on: '2026-04-01',
            ends_on: '2026-06-15',
            visibility: 'public',
            ...(program.open
              ? {
                  registration_opens_at: new Date('2026-01-15T00:00:00Z'),
                  registration_closes_at: new Date('2026-12-15T00:00:00Z'),
                }
              : {}),
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
        await trx
          .insertInto('registration_offerings')
          .values({
            id: offeringId,
            org_id: orgId,
            program_id: programId,
            division_id: divisionId,
            name: 'Participant',
            registrant_role: 'athlete',
            price_cents: program.price,
          })
          .execute();
      }
      const primaryProgramId = stableId(`demo-program-${spec.seed}-0`);
      const primaryDivisionId = stableId(`demo-division-${spec.seed}-0`);
      const primaryOfferingId = stableId(`demo-offering-${spec.seed}-0`);
      for (const [index, teamName] of spec.teamNames.entries()) {
        const teamId = stableId(`demo-team-${spec.seed}-${String(index)}`);
        const teamSeasonId = stableId(
          `demo-teamseason-${spec.seed}-${String(index)}`,
        );
        await trx
          .insertInto('teams')
          .values({
            id: teamId,
            org_id: orgId,
            name: teamName,
            sport_profile_id: sportProfileId,
          })
          .execute();
        await trx
          .insertInto('team_seasons')
          .values({
            id: teamSeasonId,
            org_id: orgId,
            team_id: teamId,
            program_id: primaryProgramId,
            division_id: primaryDivisionId,
          })
          .execute();
      }
      for (let index = 0; index < spec.households; index += 1) {
        const lastName = LAST[index % LAST.length]!;
        const householdId = stableId(`demo-hh-${spec.seed}-${String(index)}`);
        const guardianId = stableId(`demo-guardian-${spec.seed}-${String(index)}`);
        const playerId = stableId(`demo-player-${spec.seed}-${String(index)}`);
        await trx
          .insertInto('people')
          .values({
            id: guardianId,
            org_id: orgId,
            first_name: FIRST[(index * 2) % FIRST.length]!,
            last_name: lastName,
            date_of_birth: '1986-06-15',
            email: `family${String(index)}@${spec.slug}.demo.athlentry.invalid`,
          })
          .execute();
        await trx
          .insertInto('people')
          .values({
            id: playerId,
            org_id: orgId,
            first_name: FIRST[(index * 2 + 1) % FIRST.length]!,
            last_name: lastName,
            date_of_birth: '2014-03-20',
            competition_gender: index % 2 === 0 ? 'female' : 'male',
          })
          .execute();
        await trx
          .insertInto('households')
          .values({
            id: householdId,
            org_id: orgId,
            name: `${lastName} Family`,
          })
          .execute();
        await trx
          .insertInto('household_members')
          .values([
            {
              id: stableId(`demo-hhm-g-${spec.seed}-${String(index)}`),
              org_id: orgId,
              household_id: householdId,
              person_id: guardianId,
              role: 'guardian',
              financially_responsible: true,
              is_primary_contact: true,
            },
            {
              id: stableId(`demo-hhm-p-${spec.seed}-${String(index)}`),
              org_id: orgId,
              household_id: householdId,
              person_id: playerId,
              role: 'athlete',
            },
          ])
          .execute();
        await trx
          .insertInto('registrations')
          .values({
            id: stableId(`demo-reg-${spec.seed}-${String(index)}`),
            org_id: orgId,
            program_id: primaryProgramId,
            division_id: primaryDivisionId,
            offering_id: primaryOfferingId,
            person_id: playerId,
            household_id: householdId,
            registered_by_account_id: adminId,
            status: 'confirmed',
            source: 'staff',
          })
          .execute();
        if (spec.teamNames.length > 0) {
          const teamIndex = index % spec.teamNames.length;
          const teamSeasonId = stableId(
            `demo-teamseason-${spec.seed}-${String(teamIndex)}`,
          );
          await trx
            .updateTable('registrations')
            .set({ team_season_id: teamSeasonId })
            .where('org_id', '=', orgId)
            .where('id', '=', stableId(`demo-reg-${spec.seed}-${String(index)}`))
            .execute();
        }
      }
      const parentAccountId = stableId(`demo-parent-${spec.seed}`);
      const parentMembership = await trx
        .selectFrom('org_memberships')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', parentAccountId)
        .executeTakeFirst();
      if (!parentMembership) {
        await trx
          .insertInto('org_memberships')
          .values({
            id: stableId(`demo-parent-member-${spec.seed}`),
            org_id: orgId,
            account_id: parentAccountId,
            status: 'active',
            joined_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('person_account_links')
          .values({
            id: stableId(`demo-pal-${spec.seed}`),
            org_id: orgId,
            account_id: parentAccountId,
            person_id: stableId(`demo-guardian-${spec.seed}-0`),
            relationship: 'guardian',
          })
          .execute();
      }
    });
  }
}

export async function seedLoad(database: Kysely<DB>): Promise<void> {
  const orgId = stableId('load-org');
  const adminId = stableId('load-admin');
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: 'load-org',
      name: 'Load Test Organization',
      kind: 'league',
      timezone: 'America/Chicago',
      status: 'active',
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await database
    .insertInto('accounts')
    .values({
      id: adminId,
      email: 'admin@load.demo.athlentry.invalid',
      first_name: 'Load',
      last_name: 'Admin',
      date_of_birth: '1980-01-01',
      email_verified_at: new Date(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  const withOrg = createWithOrg(database);
  await withOrg({ orgId, actor: { accountId: adminId } }, async (trx) => {
    const member = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', orgId)
      .where('account_id', '=', adminId)
      .executeTakeFirst();
    if (!member) {
      await trx
        .insertInto('org_memberships')
        .values({
          id: stableId('load-member'),
          org_id: orgId,
          account_id: adminId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: stableId('load-role'),
          org_id: orgId,
          account_id: adminId,
          role: 'owner',
          scope_type: 'org',
        })
        .execute();
    }
    const people = await trx
      .selectFrom('people')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (Number(people?.count ?? 0) >= 2000) return;
    const batch = [];
    for (let index = 0; index < 2000; index += 1) {
      batch.push({
        id: newId(),
        org_id: orgId,
        first_name: FIRST[index % FIRST.length]!,
        last_name: `${LAST[index % LAST.length]!}-${String(index)}`,
        date_of_birth: '2012-01-01',
      });
    }
    for (let offset = 0; offset < batch.length; offset += 500)
      await trx
        .insertInto('people')
        .values(batch.slice(offset, offset + 500))
        .execute();
  });
}
