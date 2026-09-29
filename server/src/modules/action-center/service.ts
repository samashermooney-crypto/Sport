import { sql } from 'kysely';

import type { OrgContext, OrgTransaction } from '../../db/withOrg';

import type { ActionCenterCard, ActionCenterItem } from './schema';

export class ActionCenterError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

interface ActionRow {
  item_id: string;
  item_label: string;
  item_detail: string;
  total_count: number | string;
  amount_cents: number | string | null;
}

const administrativeRoles = ['owner', 'admin'] as const;

function hasRole(
  roles: readonly string[],
  allowed: readonly string[],
): boolean {
  return roles.some(
    (role) =>
      administrativeRoles.includes(
        role as (typeof administrativeRoles)[number],
      ) || allowed.includes(role),
  );
}

async function appendCard(
  trx: OrgTransaction,
  cards: ActionCenterCard[],
  input: {
    id: ActionCenterCard['id'];
    title: string;
    href: string;
    actionLabel?: string;
    bulkAction?: ActionCenterCard['bulkAction'];
  },
  query: ReturnType<typeof sql<ActionRow>>,
): Promise<void> {
  const { rows } = await query.execute(trx);
  const count = Number(rows[0]?.total_count ?? 0);
  if (count <= 0) return;
  const amount = rows[0]?.amount_cents;
  const items: ActionCenterItem[] = rows.slice(0, 5).map((row) => ({
    id: row.item_id,
    label: row.item_label,
    detail: row.item_detail,
    href: input.href,
  }));
  cards.push({
    id: input.id,
    title: input.title,
    count,
    ...(amount === null || amount === undefined
      ? {}
      : { amountCents: Number(amount) }),
    ...(input.bulkAction ? { bulkAction: input.bulkAction } : {}),
    actionLabel: input.actionLabel ?? 'Open queue',
    href: input.href,
    items,
  });
}

async function actorRoles(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<string[]> {
  const membership = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!membership)
    throw new ActionCenterError(404, 'NOT_FOUND', 'Action center not found');

  const assignments = await trx
    .selectFrom('role_assignments')
    .select('role')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  const roles = [...new Set(assignments.map(({ role }) => role))];
  if (roles.length === 0)
    throw new ActionCenterError(404, 'NOT_FOUND', 'Action center not found');
  return roles;
}

export async function loadActionCenter(
  context: OrgContext,
  withOrg: <T>(
    context: OrgContext,
    fn: (trx: OrgTransaction) => Promise<T>,
  ) => Promise<T>,
  now = new Date(),
): Promise<{ cards: ActionCenterCard[] }> {
  return withOrg(context, async (trx) => {
    const roles = await actorRoles(trx, context);
    const orgId = context.orgId;
    const cards: ActionCenterCard[] = [];
    const registrationHref = `/console/orgs/${orgId}/registrations?status=pending_approval`;

    if (hasRole(roles, ['registrar', 'director'])) {
      await appendCard(
        trx,
        cards,
        {
          id: 'registrations',
          title: 'Registrations awaiting approval',
          href: registrationHref,
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Registration awaiting approval'::text AS item_label,
            'Received ' || to_char(created_at AT TIME ZONE 'UTC', 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM registrations
          WHERE org_id = ${orgId}::uuid AND status = 'pending_approval'
          ORDER BY created_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'waitlist-offers',
          title: 'Waitlist offers expiring in 24 hours',
          href: `/console/orgs/${orgId}/registrations?status=offered`,
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Waitlist offer'::text AS item_label,
            'Expires ' || to_char(offer_expires_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM waitlist_entries
          WHERE org_id = ${orgId}::uuid AND status = 'offered'
            AND offer_expires_at > ${now}::timestamptz
            AND offer_expires_at <= ${new Date(now.getTime() + 24 * 60 * 60 * 1000)}::timestamptz
          ORDER BY offer_expires_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'team-offers',
          title: 'Team offers awaiting a response',
          href: `/console/orgs/${orgId}/evaluations`,
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Team placement offer'::text AS item_label,
            'Expires ' || to_char(expires_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM team_offers
          WHERE org_id = ${orgId}::uuid AND status = 'sent'
            AND responded_at IS NULL AND expires_at > ${now}::timestamptz
          ORDER BY expires_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'unassigned-players',
          title: 'Registered players without a team',
          href: `/console/orgs/${orgId}/teams`,
        },
        sql<ActionRow>`
          WITH unassigned AS (
            SELECT r.id, d.name AS division_name, r.created_at
            FROM registrations r
            JOIN registration_offerings o
              ON o.org_id = r.org_id AND o.id = r.offering_id
            JOIN divisions d ON d.org_id = r.org_id AND d.id = r.division_id
            WHERE r.org_id = ${orgId}::uuid AND r.status = 'confirmed'
              AND r.team_season_id IS NULL AND o.registrant_role = 'athlete'
          )
          SELECT id::text AS item_id,
            'Unassigned player'::text AS item_label,
            'Division: ' || division_name AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM unassigned
          ORDER BY created_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'teams',
          title: 'Teams needing a coach or roster review',
          href: `/console/orgs/${orgId}/teams`,
        },
        sql<ActionRow>`
          SELECT ts.id::text AS item_id, t.name::text AS item_label,
            CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM team_staff staff
                WHERE staff.org_id = ts.org_id AND staff.team_season_id = ts.id
                  AND staff.role = 'head_coach' AND staff.status = 'active'
              ) THEN 'No head coach assigned'
              WHEN current_roster.member_count > coalesce(ts.roster_limit,
                CASE WHEN sport.profile #>> '{roster,defaultMax}' ~ '^[0-9]+$'
                  THEN (sport.profile #>> '{roster,defaultMax}')::integer
                  ELSE NULL END)
                THEN 'Roster is above the team limit'
              ELSE 'Roster is below the sport minimum'
            END::text AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM team_seasons ts
          JOIN teams t ON t.org_id = ts.org_id AND t.id = ts.team_id
          JOIN programs program ON program.org_id = ts.org_id AND program.id = ts.program_id
          JOIN sport_profiles sport ON sport.org_id = program.org_id AND sport.id = program.sport_profile_id
          CROSS JOIN LATERAL (
            SELECT count(*)::integer AS member_count
            FROM roster_entries roster
            WHERE roster.org_id = ts.org_id AND roster.team_season_id = ts.id
              AND roster.status = 'active' AND roster.left_on IS NULL
          ) current_roster
          WHERE ts.org_id = ${orgId}::uuid AND ts.status IN ('forming', 'active')
            AND (
              NOT EXISTS (
                SELECT 1 FROM team_staff staff
                WHERE staff.org_id = ts.org_id AND staff.team_season_id = ts.id
                  AND staff.role = 'head_coach' AND staff.status = 'active'
              )
              OR current_roster.member_count > coalesce(ts.roster_limit,
                CASE WHEN sport.profile #>> '{roster,defaultMax}' ~ '^[0-9]+$'
                  THEN (sport.profile #>> '{roster,defaultMax}')::integer
                  ELSE NULL END)
              OR current_roster.member_count <
                CASE WHEN sport.profile #>> '{roster,defaultMin}' ~ '^[0-9]+$'
                  THEN (sport.profile #>> '{roster,defaultMin}')::integer
                  ELSE 0 END
            )
          ORDER BY t.name ASC
          LIMIT 5
        `,
      );
    }

    if (hasRole(roles, ['finance'])) {
      const reportsHref = `/console/orgs/${orgId}/reports`;
      await appendCard(
        trx,
        cards,
        {
          id: 'past-due-balances',
          title: 'Past-due unpaid balances',
          href: reportsHref,
          actionLabel: 'Review receivables',
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Invoice #' || number::text AS item_label,
            'Due ' || to_char(due_on, 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            sum(coalesce(balance_cents, 0)) OVER () AS amount_cents
          FROM invoices
          WHERE org_id = ${orgId}::uuid AND balance_cents > 0
            AND due_on < ${now}::date AND status IN ('open', 'partially_paid', 'past_due')
          ORDER BY due_on ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'failed-installments',
          title: 'Failed autopay installments in the last 7 days',
          href: `/console/orgs/${orgId}/money/billing`,
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Failed autopay installment'::text AS item_label,
            'Due ' || to_char(due_on AT TIME ZONE 'UTC', 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM installments
          WHERE org_id = ${orgId}::uuid AND autopay = true AND status = 'failed'
            AND updated_at >= ${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)}::timestamptz
          ORDER BY updated_at DESC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'disputes',
          title: 'Payment disputes needing evidence',
          href: reportsHref,
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Dispute evidence required'::text AS item_label,
            CASE WHEN evidence_due_by < ${now}::timestamptz
              THEN 'Past due'
              ELSE 'Due ' || to_char(evidence_due_by AT TIME ZONE 'UTC', 'Mon DD, HH24:MI')
            END::text AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM disputes
          WHERE org_id = ${orgId}::uuid AND evidence_submitted_at IS NULL
            AND evidence_due_by IS NOT NULL
            AND evidence_due_by <= ${new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)}::timestamptz
          ORDER BY evidence_due_by ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'stripe-requirements',
          title: 'Stripe account requirements due',
          href: `/console/orgs/${orgId}/money/connect`,
          actionLabel: 'Review Stripe account',
        },
        sql<ActionRow>`
          SELECT payment.id::text AS item_id,
            'Information requested by Stripe'::text AS item_label,
            'Review account requirements'::text AS item_detail,
            jsonb_array_length(CASE
              WHEN jsonb_typeof(payment.requirements->'currently_due') = 'array'
                THEN payment.requirements->'currently_due'
              ELSE '[]'::jsonb
            END) AS total_count,
            NULL::bigint AS amount_cents
          FROM payment_accounts payment
          WHERE payment.org_id = ${orgId}::uuid
            AND jsonb_array_length(CASE
              WHEN jsonb_typeof(payment.requirements->'currently_due') = 'array'
                THEN payment.requirements->'currently_due'
              ELSE '[]'::jsonb
            END) > 0
        `,
      );
    }

    if (hasRole(roles, ['compliance'])) {
      await appendCard(
        trx,
        cards,
        {
          id: 'staff-compliance',
          title: 'Staff waiting on compliance',
          href: `/console/safety/${orgId}`,
          actionLabel: 'Review compliance',
        },
        sql<ActionRow>`
          SELECT staff.id::text AS item_id,
            'Staff credential review'::text AS item_label,
            'Missing: ' || coalesce((
              SELECT string_agg(credential.name, ', ' ORDER BY credential.name)
              FROM role_credential_requirements requirement
              JOIN credential_types credential
                ON credential.org_id = requirement.org_id
                AND credential.id = requirement.credential_type_id
              WHERE requirement.org_id = staff.org_id
                AND requirement.role = staff.role AND requirement.active = true
                AND (requirement.scope_type = 'org'
                  OR (requirement.scope_type = 'program'
                    AND requirement.scope_id = program.id))
                AND NOT EXISTS (
                  SELECT 1 FROM person_credentials verified
                  WHERE verified.org_id = staff.org_id
                    AND verified.person_id = staff.person_id
                    AND verified.credential_type_id = requirement.credential_type_id
                    AND verified.status = 'verified'
                    AND (verified.expires_on IS NULL OR verified.expires_on >= ${now}::date)
                )
            ), 'credential verification') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM team_staff staff
          JOIN team_seasons team_season
            ON team_season.org_id = staff.org_id AND team_season.id = staff.team_season_id
          JOIN programs program
            ON program.org_id = team_season.org_id AND program.id = team_season.program_id
          WHERE staff.org_id = ${orgId}::uuid AND staff.status = 'pending_compliance'
          ORDER BY staff.created_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'expiring-credentials',
          title: 'Credentials expiring in 30 days',
          href: `/console/safety/${orgId}`,
          actionLabel: 'Review credentials',
        },
        sql<ActionRow>`
          SELECT credential.id::text AS item_id,
            'Credential expiration'::text AS item_label,
            'Expires ' || to_char(credential.expires_on, 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM person_credentials credential
          WHERE credential.org_id = ${orgId}::uuid AND credential.status = 'verified'
            AND credential.expires_on >= ${now}::date
            AND credential.expires_on <= (${now}::date + 30)
          ORDER BY credential.expires_on ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'incidents',
          title: 'Open incidents awaiting review',
          href: `/console/safety/${orgId}`,
          actionLabel: 'Review safety cases',
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Safety incident'::text AS item_label,
            'Occurred ' || to_char(occurred_at AT TIME ZONE 'UTC', 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM incident_reports
          WHERE org_id = ${orgId}::uuid AND status IN ('open', 'under_review')
          ORDER BY occurred_at DESC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'return-to-play',
          title: 'Injuries awaiting return-to-play review',
          href: `/console/safety/${orgId}`,
          actionLabel: 'Review clearances',
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Return-to-play review'::text AS item_label,
            'Injury occurred ' || to_char(occurred_at AT TIME ZONE 'UTC', 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM injury_reports
          WHERE org_id = ${orgId}::uuid AND status = 'return_to_play_pending'
          ORDER BY occurred_at ASC
          LIMIT 5
        `,
      );
    }

    if (hasRole(roles, ['scheduler'])) {
      const scheduleHref = `/console/orgs/${orgId}/schedule`;
      await appendCard(
        trx,
        cards,
        {
          id: 'missing-officials',
          title: 'Games without officials in the next 14 days',
          href: scheduleHref,
        },
        sql<ActionRow>`
          SELECT contest.id::text AS item_id,
            event.title::text AS item_label,
            to_char(event.starts_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM contests contest
          JOIN events event ON event.org_id = contest.org_id AND event.id = contest.event_id
          WHERE contest.org_id = ${orgId}::uuid
            AND event.starts_at >= ${now}::timestamptz
            AND event.starts_at <= ${new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)}::timestamptz
            AND event.status NOT IN ('canceled', 'cancelled', 'postponed')
            AND NOT EXISTS (
              SELECT 1 FROM official_assignments assignment
              WHERE assignment.org_id = contest.org_id AND assignment.contest_id = contest.id
                AND assignment.status IN ('offered', 'accepted', 'confirmed')
            )
          ORDER BY event.starts_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'missing-results',
          title: 'Past games without results',
          href: scheduleHref,
        },
        sql<ActionRow>`
          SELECT contest.id::text AS item_id,
            event.title::text AS item_label,
            to_char(event.ends_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM contests contest
          JOIN events event ON event.org_id = contest.org_id AND event.id = contest.event_id
          WHERE contest.org_id = ${orgId}::uuid AND event.ends_at < ${now}::timestamptz
            AND event.status NOT IN ('canceled', 'cancelled', 'postponed')
            AND EXISTS (
              SELECT 1 FROM contest_participants participant
              WHERE participant.org_id = contest.org_id AND participant.contest_id = contest.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM contest_participants participant
              JOIN contest_results result
                ON result.org_id = participant.org_id
                AND result.contest_participant_id = participant.id
              WHERE participant.org_id = contest.org_id AND participant.contest_id = contest.id
            )
          ORDER BY event.ends_at DESC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'schedule-conflicts',
          title: 'Schedule conflicts',
          href: scheduleHref,
        },
        sql<ActionRow>`
          WITH conflicts AS (
            SELECT DISTINCT first.event_id AS event_id, first.id AS booking_id
            FROM space_bookings first
            JOIN space_bookings second ON second.org_id = first.org_id
              AND second.leaf_space_id = first.leaf_space_id
              AND second.id > first.id AND second.during && first.during
            WHERE first.org_id = ${orgId}::uuid AND first.event_id IS NOT NULL
              AND second.event_id IS NOT NULL
          )
          SELECT event.id::text AS item_id, event.title::text AS item_label,
            to_char(event.starts_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM conflicts
          JOIN events event ON event.org_id = ${orgId}::uuid AND event.id = conflicts.event_id
          WHERE event.status NOT IN ('canceled', 'cancelled', 'postponed')
          ORDER BY event.starts_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'closed-space-events',
          title: 'Events affected by space closures',
          href: scheduleHref,
        },
        sql<ActionRow>`
          SELECT event.id::text AS item_id, event.title::text AS item_label,
            to_char(event.starts_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM events event
          WHERE event.org_id = ${orgId}::uuid AND event.starts_at >= ${now}::timestamptz
            AND EXISTS (
              SELECT 1 FROM closures closure
              WHERE closure.org_id = event.org_id AND event.id = ANY(closure.affected_event_ids)
            )
          ORDER BY event.starts_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'reschedules',
          title: 'Open reschedule requests',
          href: scheduleHref,
        },
        sql<ActionRow>`
          SELECT request.id::text AS item_id,
            'Event reschedule request'::text AS item_label,
            to_char(request.created_at AT TIME ZONE 'UTC', 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM reschedule_requests request
          WHERE request.org_id = ${orgId}::uuid AND request.status = 'open'
          ORDER BY request.created_at ASC
          LIMIT 5
        `,
      );
    }

    if (hasRole(roles, ['volunteer_coordinator'])) {
      await appendCard(
        trx,
        cards,
        {
          id: 'volunteer-shifts',
          title: 'Volunteer shifts with open slots in the next 14 days',
          href: `/console/orgs/${orgId}/volunteers`,
          actionLabel: 'Fill open shifts',
        },
        sql<ActionRow>`
          WITH open_shifts AS (
            SELECT shift.id, shift.starts_at, shift.slots - count(signup.id) AS open_slots
            FROM volunteer_shifts shift
            LEFT JOIN volunteer_signups signup ON signup.org_id = shift.org_id
              AND signup.volunteer_shift_id = shift.id
              AND signup.status IN ('signed_up', 'confirmed', 'checked_in', 'completed')
            WHERE shift.org_id = ${orgId}::uuid
              AND shift.starts_at >= ${now}::timestamptz
              AND shift.starts_at <= ${new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)}::timestamptz
            GROUP BY shift.id, shift.starts_at, shift.slots
            HAVING shift.slots - count(signup.id) > 0
          )
          SELECT id::text AS item_id,
            'Volunteer shift'::text AS item_label,
            open_slots::text || ' open slot(s) · ' || to_char(starts_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') AS item_detail,
            sum(open_slots) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM open_shifts
          ORDER BY starts_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'volunteer-households',
          title: 'Households behind on volunteer requirements',
          href: `/console/orgs/${orgId}/volunteers`,
          actionLabel: 'Review requirements',
        },
        sql<ActionRow>`
          WITH targets AS (
            SELECT requirement.id AS requirement_id,
              registration.household_id,
              requirement.deadline,
              requirement.unit,
              CASE
                WHEN requirement.amount_per_household IS NOT NULL
                  THEN requirement.amount_per_household
                ELSE requirement.amount_per_athlete * count(DISTINCT registration.person_id)
              END AS required_units
            FROM volunteer_requirements requirement
            JOIN registrations registration
              ON registration.org_id = requirement.org_id
              AND registration.status = 'confirmed'
            JOIN programs program
              ON program.org_id = registration.org_id
              AND program.id = registration.program_id
            WHERE requirement.org_id = ${orgId}::uuid
              AND (
                requirement.program_id = registration.program_id
                OR requirement.season_id = program.season_id
              )
            GROUP BY requirement.id, registration.household_id,
              requirement.deadline, requirement.unit,
              requirement.amount_per_household, requirement.amount_per_athlete
          ), signup_credit AS (
            SELECT shift.requirement_id, signup.household_id,
              sum(CASE WHEN requirement.unit = 'hours'
                THEN signup.hours_credited ELSE 1 END) AS credited_units
            FROM volunteer_signups signup
            JOIN volunteer_shifts shift
              ON shift.org_id = signup.org_id AND shift.id = signup.volunteer_shift_id
            JOIN volunteer_requirements requirement
              ON requirement.org_id = shift.org_id AND requirement.id = shift.requirement_id
            WHERE signup.org_id = ${orgId}::uuid
              AND signup.status = 'completed'
            GROUP BY shift.requirement_id, signup.household_id
          ), buyout_credit AS (
            SELECT buyout.requirement_id, buyout.household_id,
              sum(buyout.units) AS credited_units
            FROM volunteer_buyouts buyout
            JOIN invoices invoice
              ON invoice.org_id = buyout.org_id AND invoice.id = buyout.invoice_id
            WHERE buyout.org_id = ${orgId}::uuid AND invoice.status = 'paid'
            GROUP BY buyout.requirement_id, buyout.household_id
          )
          SELECT (target.requirement_id::text || ':' || target.household_id::text) AS item_id,
            'Household volunteer requirement'::text AS item_label,
            greatest(target.required_units
              - coalesce(signup_credit.credited_units, 0)
              - coalesce(buyout_credit.credited_units, 0), 0)::text
              || ' ' || target.unit || ' remaining · due '
              || to_char(target.deadline, 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM targets target
          LEFT JOIN signup_credit ON signup_credit.requirement_id = target.requirement_id
            AND signup_credit.household_id = target.household_id
          LEFT JOIN buyout_credit ON buyout_credit.requirement_id = target.requirement_id
            AND buyout_credit.household_id = target.household_id
          WHERE target.required_units > coalesce(signup_credit.credited_units, 0)
            + coalesce(buyout_credit.credited_units, 0)
          ORDER BY target.deadline ASC
          LIMIT 5
        `,
      );
    }

    if (hasRole(roles, ['communications'])) {
      const websiteHref = `/console/orgs/${orgId}/website`;
      await appendCard(
        trx,
        cards,
        {
          id: 'unread-contacts',
          title: 'Unread website contact submissions',
          href: `${websiteHref}/contacts`,
          actionLabel: 'Open contact inbox',
          bulkAction: 'mark_contacts_read',
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'New contact submission'::text AS item_label,
            'Received ' || to_char(created_at AT TIME ZONE 'UTC', 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM contact_submissions
          WHERE org_id = ${orgId}::uuid AND status = 'new'
          ORDER BY created_at ASC
          LIMIT 5
        `,
      );

      await appendCard(
        trx,
        cards,
        {
          id: 'failed-messages',
          title: 'Messages that failed to deliver',
          href: `/console/orgs/${orgId}/messages`,
          actionLabel: 'Review delivery failures',
        },
        sql<ActionRow>`
          SELECT id::text AS item_id,
            'Message delivery failed'::text AS item_label,
            to_char(coalesce(last_attempt_at, created_at) AT TIME ZONE 'UTC', 'Mon DD') AS item_detail,
            count(*) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM message_deliveries
          WHERE org_id = ${orgId}::uuid AND status IN ('failed', 'bounced')
          ORDER BY coalesce(last_attempt_at, created_at) DESC
          LIMIT 5
        `,
      );
    }

    if (hasRole(roles, ['registrar'])) {
      await appendCard(
        trx,
        cards,
        {
          id: 'import-errors',
          title: 'Imports with row errors',
          href: `/console/orgs/${orgId}/imports`,
          actionLabel: 'Review import errors',
        },
        sql<ActionRow>`
          WITH bad_batches AS (
            SELECT batch.id, batch.created_at, count(row.id) AS error_rows
            FROM import_batches batch
            JOIN import_rows row ON row.org_id = batch.org_id AND row.batch_id = batch.id
            WHERE batch.org_id = ${orgId}::uuid AND batch.status IN ('preview', 'failed')
              AND CASE WHEN jsonb_typeof(row.issues) = 'array'
                THEN jsonb_array_length(row.issues) > 0 ELSE false END
            GROUP BY batch.id, batch.created_at
          )
          SELECT id::text AS item_id,
            'Import batch with row errors'::text AS item_label,
            error_rows::text || ' row(s) need review' AS item_detail,
            sum(error_rows) OVER () AS total_count,
            NULL::bigint AS amount_cents
          FROM bad_batches
          ORDER BY created_at DESC
          LIMIT 5
        `,
      );
    }

    return { cards };
  });
}
