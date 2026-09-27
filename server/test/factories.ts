import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import type { Insertable, Kysely } from 'kysely';

import type { DB } from '../src/db/types';
import { createWithOrg } from '../src/db/withOrg';
import type { OrgContext, OrgTransaction } from '../src/db/withOrg';

export interface ActorFixture extends OrgContext {
  accountId: string;
}

export interface ProgramFixture {
  seasonId: string;
  sportProfileId: string;
  programId: string;
  divisionId: string;
  offeringId: string;
}

type TenantTable = {
  [Table in keyof DB]: 'org_id' extends keyof DB[Table] ? Table : never;
}[keyof DB];

export function createTestFactories(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);

  async function scoped<T>(
    actor: ActorFixture,
    action: (trx: OrgTransaction) => Promise<T>,
  ): Promise<T> {
    return withOrg(actor, action);
  }

  async function row<Table extends TenantTable>(
    actor: ActorFixture,
    table: Table,
    values: Insertable<DB[Table]>,
  ): Promise<void> {
    if ('org_id' in values && values.org_id !== actor.orgId) {
      throw new Error('Factory row belongs to a different organization');
    }
    await scoped(actor, async (trx) => {
      await trx.insertInto(table).values(values).execute();
    });
  }

  async function actor(): Promise<ActorFixture> {
    const accountId = newId();
    const orgId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `fixture-${randomUUID()}@example.invalid`,
        first_name: 'Test',
        last_name: 'Actor',
        date_of_birth: '1990-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `fixture-${randomUUID().slice(0, 12)}`,
        name: 'Fixture Organization',
        kind: 'club',
        timezone: 'America/Chicago',
      })
      .execute();
    await withOrg({ orgId, actor: { accountId } }, async (trx) => {
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
          pending_mfa: true,
        })
        .execute();
    });
    return { orgId, accountId, actor: { accountId } };
  }

  async function person(
    actor: ActorFixture,
    overrides: {
      firstName?: string;
      lastName?: string;
      dateOfBirth?: string;
    } = {},
  ): Promise<string> {
    const id = newId();
    await scoped(actor, (trx) =>
      trx
        .insertInto('people')
        .values({
          id,
          org_id: actor.orgId,
          first_name: overrides.firstName ?? 'Alex',
          last_name: overrides.lastName ?? 'Athlete',
          date_of_birth: overrides.dateOfBirth ?? '2012-01-01',
        })
        .execute()
        .then(() => undefined),
    );
    return id;
  }

  async function household(actor: ActorFixture): Promise<string> {
    const id = newId();
    await scoped(actor, (trx) =>
      trx
        .insertInto('households')
        .values({
          id,
          org_id: actor.orgId,
          name: 'Fixture Household',
        })
        .execute()
        .then(() => undefined),
    );
    return id;
  }

  async function program(actor: ActorFixture): Promise<ProgramFixture> {
    const seasonId = newId();
    const sportProfileId = newId();
    const programId = newId();
    const divisionId = newId();
    const offeringId = newId();
    await scoped(actor, async (trx) => {
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: actor.orgId,
          name: 'Fixture Season',
          starts_on: '2026-01-01',
          ends_on: '2026-12-31',
        })
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({
          id: sportProfileId,
          org_id: actor.orgId,
          name: 'Soccer',
          profile: builtInSportTemplates[0],
        })
        .execute();
      await trx
        .insertInto('programs')
        .values({
          id: programId,
          org_id: actor.orgId,
          season_id: seasonId,
          sport_profile_id: sportProfileId,
          mode: 'league',
          name: 'Fixture League',
          slug: `fixture-${randomUUID().slice(0, 8)}`,
          starts_on: '2026-03-01',
          ends_on: '2026-11-30',
        })
        .execute();
      await trx
        .insertInto('divisions')
        .values({
          id: divisionId,
          org_id: actor.orgId,
          program_id: programId,
          name: 'Open',
          level: 'open',
        })
        .execute();
      await trx
        .insertInto('registration_offerings')
        .values({
          id: offeringId,
          org_id: actor.orgId,
          program_id: programId,
          division_id: divisionId,
          name: 'Player',
          registrant_role: 'athlete',
          price_cents: 0,
        })
        .execute();
    });
    return { seasonId, sportProfileId, programId, divisionId, offeringId };
  }

  async function team(
    actor: ActorFixture,
    fixture: ProgramFixture,
  ): Promise<{ teamId: string; teamSeasonId: string }> {
    const teamId = newId();
    const teamSeasonId = newId();
    await scoped(actor, async (trx) => {
      await trx
        .insertInto('teams')
        .values({
          id: teamId,
          org_id: actor.orgId,
          name: 'Fixture Team',
          sport_profile_id: fixture.sportProfileId,
        })
        .execute();
      await trx
        .insertInto('team_seasons')
        .values({
          id: teamSeasonId,
          org_id: actor.orgId,
          team_id: teamId,
          program_id: fixture.programId,
          division_id: fixture.divisionId,
        })
        .execute();
    });
    return { teamId, teamSeasonId };
  }

  async function registration(
    actor: ActorFixture,
    fixture: ProgramFixture,
    personId: string,
    householdId: string,
  ): Promise<string> {
    const id = newId();
    await scoped(actor, (trx) =>
      trx
        .insertInto('registrations')
        .values({
          id,
          org_id: actor.orgId,
          program_id: fixture.programId,
          division_id: fixture.divisionId,
          offering_id: fixture.offeringId,
          person_id: personId,
          household_id: householdId,
          registered_by_account_id: actor.accountId,
          source: 'staff',
          status: 'confirmed',
        })
        .execute()
        .then(() => undefined),
    );
    return id;
  }

  async function invoice(actor: ActorFixture, number: number): Promise<string> {
    const id = newId();
    await scoped(actor, (trx) =>
      trx
        .insertInto('invoices')
        .values({
          id,
          org_id: actor.orgId,
          number,
          account_id: actor.accountId,
          source: 'staff',
          status: 'draft',
        })
        .execute()
        .then(() => undefined),
    );
    return id;
  }

  async function event(actor: ActorFixture): Promise<string> {
    const id = newId();
    await scoped(actor, (trx) =>
      trx
        .insertInto('events')
        .values({
          id,
          org_id: actor.orgId,
          kind: 'practice',
          title: 'Fixture Practice',
          starts_at: '2026-09-26T16:00:00Z',
          ends_at: '2026-09-26T17:00:00Z',
          timezone: 'America/Chicago',
        })
        .execute()
        .then(() => undefined),
    );
    return id;
  }

  async function contest(
    actor: ActorFixture,
    eventId: string,
    sportProfileId: string,
  ): Promise<string> {
    const id = newId();
    await scoped(actor, (trx) =>
      trx
        .insertInto('contests')
        .values({
          id,
          org_id: actor.orgId,
          event_id: eventId,
          sport_profile_id: sportProfileId,
          profile_version: 1,
          format: 'head_to_head_score',
        })
        .execute()
        .then(() => undefined),
    );
    return id;
  }

  return {
    actor,
    scoped,
    row,
    person,
    household,
    program,
    team,
    registration,
    invoice,
    event,
    contest,
  };
}
