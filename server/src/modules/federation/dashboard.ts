import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

export interface AssociationDashboard {
  members: {
    total: number;
    active: number;
    invited: number;
    suspended: number;
  };
  entries: Record<string, number>;
  referees: { poolSize: number; upcomingAssignments: number };
  discipline: { open: number; appealed: number };
  fees: {
    assessedCents: number;
    invoicedCents: number;
    outstandingCents: number;
    invoiceCount: number;
  };
  schedule: {
    linkedHostedGames: number;
    upcomingContests: number;
  };
}

/** League-side association dashboard; all league-owned data, no privileged reads. */
export async function associationDashboard(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<AssociationDashboard> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const relationships = await trx
      .selectFrom('org_relationships')
      .select('status')
      .where('parent_org_id', '=', context.orgId)
      .where('status', 'in', ['invited', 'active', 'suspended'])
      .execute();
    const memberCounts = {
      total: relationships.length,
      active: relationships.filter((r) => r.status === 'active').length,
      invited: relationships.filter((r) => r.status === 'invited').length,
      suspended: relationships.filter((r) => r.status === 'suspended').length,
    };
    const entries = await trx
      .selectFrom('team_entries')
      .select(['status'])
      .select((eb) => eb.fn.countAll().as('count'))
      .where('org_id', '=', context.orgId)
      .where('entrant_org_id', 'is not', null)
      .groupBy('status')
      .execute();
    const entryCounts: Record<string, number> = {};
    for (const row of entries) entryCounts[row.status] = Number(row.count);
    const referees = await trx
      .selectFrom('official_profiles')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('org_id', '=', context.orgId)
      .where('active', '=', true)
      .executeTakeFirst();
    const upcomingAssignments = await trx
      .selectFrom('official_assignments as a')
      .innerJoin('contests', (join) =>
        join
          .onRef('contests.org_id', '=', 'a.org_id')
          .onRef('contests.id', '=', 'a.contest_id'),
      )
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'contests.org_id')
          .onRef('events.id', '=', 'contests.event_id'),
      )
      .select((eb) => eb.fn.countAll().as('count'))
      .where('a.org_id', '=', context.orgId)
      .where('a.status', 'in', ['offered', 'accepted', 'confirmed'])
      .where('events.starts_at', '>=', new Date())
      .executeTakeFirst();
    const discipline = await trx
      .selectFrom('federation_discipline_records')
      .select(['status'])
      .select((eb) => eb.fn.countAll().as('count'))
      .where('org_id', '=', context.orgId)
      .where('status', 'in', ['active', 'appealed'])
      .groupBy('status')
      .execute();
    const feeAgg = await trx
      .selectFrom('federation_fee_assessments as f')
      .leftJoin('invoices', (join) =>
        join
          .onRef('invoices.org_id', '=', 'f.org_id')
          .onRef('invoices.id', '=', 'f.invoice_id'),
      )
      .select([
        sql<string>`coalesce(sum(f.amount_cents), 0)`.as('assessed'),
        sql<string>`coalesce(sum(case when f.status = 'invoiced' then f.amount_cents else 0 end), 0)`.as(
          'invoiced',
        ),
        sql<string>`coalesce(sum(case when f.status = 'invoiced' then invoices.balance_cents else 0 end), 0)`.as(
          'outstanding',
        ),
        sql<string>`coalesce(sum(case when f.status = 'invoiced' then 1 else 0 end), 0)`.as(
          'invoice_count',
        ),
      ])
      .where('f.org_id', '=', context.orgId)
      .where('f.status', 'in', ['draft', 'invoiced'])
      .executeTakeFirst();
    // Contributed windows live in club orgs; the dashboard reports what the
    // league org can see directly — hosted-game links and its own contests.
    const links = await trx
      .selectFrom('federation_event_links')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('league_org_id', '=', context.orgId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    const upcoming = await trx
      .selectFrom('contests')
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'contests.org_id')
          .onRef('events.id', '=', 'contests.event_id'),
      )
      .select((eb) => eb.fn.countAll().as('count'))
      .where('contests.org_id', '=', context.orgId)
      .where('contests.status', '=', 'scheduled')
      .where('events.starts_at', '>=', new Date())
      .executeTakeFirstOrThrow();
    return {
      members: memberCounts,
      entries: entryCounts,
      referees: {
        poolSize: Number(referees?.count ?? 0),
        upcomingAssignments: Number(upcomingAssignments?.count ?? 0),
      },
      discipline: {
        open: Number(
          discipline.find((row) => row.status === 'active')?.count ?? 0,
        ),
        appealed: Number(
          discipline.find((row) => row.status === 'appealed')?.count ?? 0,
        ),
      },
      fees: {
        assessedCents: Number(feeAgg?.assessed ?? 0),
        invoicedCents: Number(feeAgg?.invoiced ?? 0),
        outstandingCents: Number(feeAgg?.outstanding ?? 0),
        invoiceCount: Number(feeAgg?.invoice_count ?? 0),
      },
      schedule: {
        linkedHostedGames: Number(links.count),
        upcomingContests: Number(upcoming.count),
      },
    };
  });
}
