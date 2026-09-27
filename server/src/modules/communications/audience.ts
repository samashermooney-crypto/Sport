import { Temporal } from '@js-temporal/polyfill';

import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';

import type { AudienceSpec } from './schema';

export type ResolvedRecipient = {
  accountId: string;
  aboutPersonId: string | null;
  firstName: string;
  displayName: string;
  locale: 'en' | 'es';
  email: string;
  phoneE164: string | null;
  phoneVerified: boolean;
  timezone: string;
};

type SelectorSet = AudienceSpec['include'];

function dateOnly(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}

async function collectSelectedPeople(
  trx: OrgTransaction,
  orgId: string,
  selectors: SelectorSet,
): Promise<Set<string>> {
  const ids = new Set(selectors.personIds ?? []);
  const add = (personIds: readonly string[]) => {
    personIds.forEach((id) => ids.add(id));
  };

  if (selectors.teamSeasonIds?.length) {
    const [roster, staff] = await Promise.all([
      trx
        .selectFrom('roster_entries')
        .select('person_id')
        .where('org_id', '=', orgId)
        .where('team_season_id', 'in', selectors.teamSeasonIds)
        .where('status', 'in', ['active', 'injured', 'suspended'])
        .execute(),
      trx
        .selectFrom('team_staff')
        .select('person_id')
        .where('org_id', '=', orgId)
        .where('team_season_id', 'in', selectors.teamSeasonIds)
        .where('status', '=', 'active')
        .execute(),
    ]);
    add(roster.map((row) => row.person_id));
    add(staff.map((row) => row.person_id));
  }
  if (selectors.programIds?.length) {
    const registrations = await trx
      .selectFrom('registrations')
      .select('person_id')
      .where('org_id', '=', orgId)
      .where('program_id', 'in', selectors.programIds)
      .where('status', 'not in', ['canceled', 'withdrawn', 'transferred_out'])
      .execute();
    add(registrations.map((row) => row.person_id));
    const [teamStaff, roster] = await Promise.all([
      trx
        .selectFrom('team_staff as staff')
        .innerJoin('team_seasons as season', (join) =>
          join
            .onRef('season.id', '=', 'staff.team_season_id')
            .onRef('season.org_id', '=', 'staff.org_id'),
        )
        .select('staff.person_id')
        .where('staff.org_id', '=', orgId)
        .where('season.program_id', 'in', selectors.programIds)
        .where('staff.status', '=', 'active')
        .execute(),
      trx
        .selectFrom('roster_entries as roster')
        .innerJoin('team_seasons as season', (join) =>
          join
            .onRef('season.id', '=', 'roster.team_season_id')
            .onRef('season.org_id', '=', 'roster.org_id'),
        )
        .select('roster.person_id')
        .where('roster.org_id', '=', orgId)
        .where('season.program_id', 'in', selectors.programIds)
        .where('roster.status', 'in', ['active', 'injured', 'suspended'])
        .execute(),
    ]);
    add(teamStaff.map((row) => row.person_id));
    add(roster.map((row) => row.person_id));
  }
  if (selectors.roles?.includes('athletes_guardians')) {
    const [registrations, roster] = await Promise.all([
      trx
        .selectFrom('registrations')
        .select('person_id')
        .where('org_id', '=', orgId)
        .where('status', 'not in', ['canceled', 'withdrawn', 'transferred_out'])
        .execute(),
      trx
        .selectFrom('roster_entries')
        .select('person_id')
        .where('org_id', '=', orgId)
        .where('status', 'in', ['active', 'injured', 'suspended'])
        .execute(),
    ]);
    add(registrations.map((row) => row.person_id));
    add(roster.map((row) => row.person_id));
  }
  if (selectors.roles?.includes('coaches')) {
    const staff = await trx
      .selectFrom('team_staff')
      .select('person_id')
      .where('org_id', '=', orgId)
      .where('status', '=', 'active')
      .execute();
    add(staff.map((row) => row.person_id));
  }
  if (selectors.roles?.includes('officials')) {
    const assignments = await trx
      .selectFrom('official_assignments')
      .select('person_id')
      .where('org_id', '=', orgId)
      .where('status', '!=', 'canceled')
      .execute();
    add(assignments.map((row) => row.person_id));
  }
  if (selectors.roles?.includes('volunteers')) {
    const staff = await trx
      .selectFrom('team_staff')
      .select('person_id')
      .where('org_id', '=', orgId)
      .where('role', 'in', ['team_manager', 'trainer'])
      .where('status', '=', 'active')
      .execute();
    add(staff.map((row) => row.person_id));
  }
  return ids;
}

async function collectBoardAccounts(
  trx: OrgTransaction,
  orgId: string,
): Promise<Set<string>> {
  const rows = await trx
    .selectFrom('role_assignments')
    .select('account_id')
    .where('org_id', '=', orgId)
    .where('role', 'in', ['owner', 'admin', 'director'])
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  return new Set(rows.map((row) => row.account_id));
}

async function collectGuardianAccounts(
  trx: OrgTransaction,
  orgId: string,
  personIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (!personIds.length) return result;
  const rows = await trx
    .selectFrom('person_account_links')
    .select(['person_id', 'account_id'])
    .where('org_id', '=', orgId)
    .where('person_id', 'in', [...personIds])
    .where('relationship', '=', 'guardian')
    .where('revoked_at', 'is', null)
    .execute();
  for (const row of rows) {
    const guardians = result.get(row.person_id) ?? new Set<string>();
    guardians.add(row.account_id);
    result.set(row.person_id, guardians);
  }
  return result;
}

async function personAccountIds(
  trx: OrgTransaction,
  orgId: string,
  personIds: readonly string[],
): Promise<Map<string, string>> {
  if (!personIds.length) return new Map();
  const rows = await trx
    .selectFrom('person_account_links')
    .select(['person_id', 'account_id'])
    .where('org_id', '=', orgId)
    .where('person_id', 'in', [...personIds])
    .where('relationship', '=', 'self')
    .where('revoked_at', 'is', null)
    .execute();
  return new Map(rows.map((row) => [row.person_id, row.account_id]));
}

export async function resolveAudience(
  context: OrgContext,
  audience: AudienceSpec,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
): Promise<ResolvedRecipient[]> {
  return runWithOrg(context, async (trx) => {
    const orgId = context.orgId;
    const includedPeople = await collectSelectedPeople(
      trx,
      orgId,
      audience.include,
    );
    const excludedPeople = await collectSelectedPeople(
      trx,
      orgId,
      audience.exclude,
    );
    for (const personId of excludedPeople) includedPeople.delete(personId);
    const boardAccounts = audience.include.roles?.includes('board')
      ? await collectBoardAccounts(trx, orgId)
      : new Set<string>();
    const excludedBoardAccounts = audience.exclude.roles?.includes('board')
      ? await collectBoardAccounts(trx, orgId)
      : new Set<string>();
    for (const accountId of excludedBoardAccounts)
      boardAccounts.delete(accountId);

    const people = includedPeople.size
      ? await trx
          .selectFrom('people')
          .select(['id', 'date_of_birth', 'first_name', 'last_name'])
          .where('org_id', '=', orgId)
          .where('id', 'in', [...includedPeople])
          .where('status', '=', 'active')
          .execute()
      : [];
    const personIds = people.map((person) => person.id);
    const [selfLinks, guardians] = await Promise.all([
      personAccountIds(trx, orgId, personIds),
      collectGuardianAccounts(trx, orgId, personIds),
    ]);
    const targetAccounts = new Map<string, string | null>();
    for (const person of people) {
      const dob = Temporal.PlainDate.from(dateOnly(person.date_of_birth));
      const today = Temporal.Instant.from(now.toISOString())
        .toZonedDateTimeISO('UTC')
        .toPlainDate();
      const birthday = Temporal.PlainDate.from({
        year: 2000,
        month: dob.month,
        day: dob.day,
      }).with({ year: today.year }, { overflow: 'constrain' });
      const age =
        today.year -
        dob.year -
        (Temporal.PlainDate.compare(today, birthday) < 0 ? 1 : 0);
      const personGuardians = guardians.get(person.id) ?? new Set<string>();
      if (age < 18) {
        for (const accountId of personGuardians)
          targetAccounts.set(accountId, person.id);
      } else {
        const accountId = selfLinks.get(person.id);
        if (accountId) targetAccounts.set(accountId, person.id);
      }
    }
    for (const accountId of boardAccounts) targetAccounts.set(accountId, null);

    const accountIds = [...targetAccounts.keys()];
    if (!accountIds.length) return [];
    const rows = await trx
      .selectFrom('accounts')
      .select([
        'id',
        'first_name',
        'last_name',
        'email',
        'phone_e164',
        'phone_verified_at',
        'locale',
        'timezone',
        'date_of_birth',
        'status',
      ])
      .where('id', 'in', accountIds)
      .where('status', '=', 'active')
      .execute();
    return rows.map((account) => ({
      accountId: account.id,
      aboutPersonId: targetAccounts.get(account.id) ?? null,
      firstName: account.first_name,
      displayName: `${account.first_name} ${account.last_name}`.trim(),
      locale: account.locale === 'es' ? 'es' : 'en',
      email: account.email,
      phoneE164: account.phone_e164,
      phoneVerified: account.phone_verified_at !== null,
      timezone: account.timezone ?? 'UTC',
    }));
  });
}
