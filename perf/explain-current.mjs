import { sql } from 'kysely';

import { createDatabase } from '../server/src/db/kysely.js';
import { createWithOrg } from '../server/src/db/withOrg.js';

const zeroId = '00000000-0000-0000-0000-000000000000';

function record(value) {
  return value && typeof value === 'object' ? value : undefined;
}

function rootPlan(value) {
  if (!Array.isArray(value)) return undefined;
  return record(record(value[0])?.Plan);
}

function planNodes(root) {
  if (!root) return [];
  const node = [
    root['Node Type'],
    root['Relation Name'] ? `on ${root['Relation Name']}` : undefined,
    root['Index Name'] ? `using ${root['Index Name']}` : undefined,
    `estimated_rows=${String(root['Plan Rows'] ?? 0)}`,
    `actual_rows=${String(root['Actual Rows'] ?? 0)}`,
    `actual_ms=${String(root['Actual Total Time'] ?? 0)}`,
    `shared_hit=${String(root['Shared Hit Blocks'] ?? 0)}`,
    `shared_read=${String(root['Shared Read Blocks'] ?? 0)}`,
  ]
    .filter(Boolean)
    .join(' ');
  return [node, ...(root.Plans ?? []).flatMap(planNodes)];
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = createDatabase(connectionString);
  try {
    // organizations is the global tenant directory; tenant tables below are
    // inspected inside withOrg transactions using the application role.
    const organization = await database
      .selectFrom('organizations')
      .select(['id', 'slug'])
      .orderBy(sql`CASE WHEN slug = 'load-org' THEN 0 ELSE 1 END`)
      .orderBy('slug')
      .limit(1)
      .executeTakeFirst();
    const context = {
      orgId: organization?.id ?? zeroId,
      actor: { accountId: zeroId },
    };
    const withOrg = createWithOrg(database);
    const reports = await withOrg(context, async (trx) => {
      const [
        hold,
        counter,
        attendance,
        roster,
        schedule,
        snapshot,
        recentEmail,
        payment,
      ] = await Promise.all([
        trx
          .selectFrom('capacity_holds')
          .select('checkout_id')
          .limit(1)
          .executeTakeFirst(),
        trx
          .selectFrom('capacity_counters')
          .select(['subject_type', 'subject_id'])
          .limit(1)
          .executeTakeFirst(),
        trx
          .selectFrom('attendance')
          .select('event_id')
          .limit(1)
          .executeTakeFirst(),
        trx
          .selectFrom('roster_entries')
          .select('team_season_id')
          .where('status', 'in', ['active', 'injured', 'suspended'])
          .limit(1)
          .executeTakeFirst(),
        trx
          .selectFrom('events')
          .select('space_id')
          .where('space_id', 'is not', null)
          .where('published', '=', true)
          .where('starts_at', '>=', sql`now() - interval '1 day'`)
          .limit(1)
          .executeTakeFirst(),
        trx
          .selectFrom('standings_snapshots')
          .select(['scope_type', 'scope_id'])
          .limit(1)
          .executeTakeFirst(),
        trx
          .selectFrom('message_deliveries')
          .select('id')
          .where('channel', '=', 'email')
          .where('sent_at', '>=', sql`now() - interval '30 minutes'`)
          .limit(1)
          .executeTakeFirst(),
        trx.selectFrom('payments').select('id').limit(1).executeTakeFirst(),
      ]);
      const cases = [
        {
          name: 'checkout-capacity-holds',
          sampleFound: Boolean(hold),
          query: sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT subject_type, subject_id, quantity, released_at, converted_at
            FROM capacity_holds
            WHERE org_id = ${context.orgId}::uuid
              AND checkout_id = ${hold?.checkout_id ?? zeroId}::uuid
          `,
        },
        {
          name: 'checkout-capacity-counter',
          sampleFound: Boolean(counter),
          query: sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT id, capacity, confirmed, held
            FROM capacity_counters
            WHERE org_id = ${context.orgId}::uuid
              AND subject_type = ${counter?.subject_type ?? 'offering'}
              AND subject_id = ${counter?.subject_id ?? zeroId}::uuid
          `,
        },
        {
          name: 'game-day-attendance',
          sampleFound: Boolean(attendance),
          query: sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT id, person_id, status, rsvp
            FROM attendance
            WHERE org_id = ${context.orgId}::uuid
              AND event_id = ${attendance?.event_id ?? zeroId}::uuid
              AND status = 'present'
          `,
        },
        {
          name: 'game-day-roster',
          sampleFound: Boolean(roster),
          query: sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT roster_entries.person_id, roster_entries.team_season_id,
              roster_entries.status, people.first_name, people.last_name
            FROM roster_entries
            INNER JOIN people
              ON people.org_id = roster_entries.org_id
              AND people.id = roster_entries.person_id
            WHERE roster_entries.org_id = ${context.orgId}::uuid
              AND roster_entries.team_season_id = ${roster?.team_season_id ?? zeroId}::uuid
              AND roster_entries.status IN ('active', 'injured', 'suspended')
          `,
        },
        {
          name: 'public-facility-schedule',
          sampleFound: Boolean(schedule?.space_id),
          query: sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT id, title, kind, starts_at, ends_at, status
            FROM events
            WHERE org_id = ${context.orgId}::uuid
              AND space_id = ${schedule?.space_id ?? zeroId}::uuid
              AND published = true
              AND starts_at >= now() - interval '1 day'
            ORDER BY starts_at
            LIMIT 500
          `,
        },
        {
          name: 'public-standings-snapshot',
          sampleFound: Boolean(snapshot),
          query: sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT id, rows, computed_at
            FROM standings_snapshots
            WHERE org_id = ${context.orgId}::uuid
              AND scope_type = ${snapshot?.scope_type ?? 'program'}
              AND scope_id = ${snapshot?.scope_id ?? zeroId}::uuid
            ORDER BY computed_at DESC
            LIMIT 1
          `,
        },
        {
          name: 'email-delivery-window',
          sampleFound: Boolean(recentEmail),
          query: sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT count(*)::integer,
              count(*) FILTER (WHERE status = 'bounced')::integer
            FROM message_deliveries
            WHERE org_id = ${context.orgId}::uuid
              AND channel = 'email'
              AND sent_at >= now() - interval '30 minutes'
          `,
        },
        {
          name: 'payment-alert-window',
          sampleFound: Boolean(payment),
          query: sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT max(succeeded_at),
              count(*) FILTER (
                WHERE created_at >= now() - interval '15 minutes'
              ),
              count(*) FILTER (
                WHERE created_at >= now() - interval '15 minutes'
                  AND status = 'failed'
              )
            FROM payments
          `,
        },
      ];
      const results = [];
      for (const item of cases) {
        const explained = await item.query.execute(trx);
        const root = rootPlan(explained.rows[0]?.['QUERY PLAN']);
        results.push({
          name: item.name,
          sampleFound: item.sampleFound,
          nodes: planNodes(root),
        });
      }
      return results;
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          tenant_directory_nonempty: Boolean(organization),
          analyzed_tenant_slug: organization?.slug ?? null,
          reports,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await database.destroy();
  }
}

await main();
