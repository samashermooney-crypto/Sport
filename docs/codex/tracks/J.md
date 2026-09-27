# Track J — Phase 13 Federation

Status: in-progress
Branch: `track/j-federation`
Worktree: `/Users/sammooney/Sport-j-federation`
Stack: `COMPOSE_PROJECT_NAME=athlentry_j`, `PORT_OFFSET=1000` (Postgres 6432; mailpit API rebound to 9325 because 9025 was taken by `athlentry_a_identity`).

## Scope
Phase 13: org relationships + data-sharing agreements, member-club team entries with roster snapshots, privileged allow-listed cross-org reads audited in both orgs, league-wide scheduling over member-club availability (shared `schedule-generator`), cross-club results/standings/discipline, league referee pool, association dashboard, league fees to member clubs via finance.

## Design notes (summary)
- `org_relationships` is a two-org RLS table (policy on `parent_org_id`/`child_org_id`), status enum per spec (`invited|active|suspended|ended`); `initiator` distinguishes invite vs join-request.
- Member-club teams enter league programs as `team_entries` rows in the league org with `entrant_org_id` set and a league-side `external_teams` row (`linked_org_id` = club). Rosters arrive as immutable allow-listed snapshots (`federation_roster_snapshots`).
- Cross-org operations run through the privileged federation service (`DATABASE_ADMIN_URL` role) in one transaction that also writes audit rows in BOTH orgs. Field allow-lists are enforced by construction (explicit column lists, never SELECT *).
- Club hosts a league game → league `events`/`contests` row (canonical, external teams) + a mirror `events` row + `space_bookings` leaf rows in the club org (exclusion constraint does conflict enforcement) + a `federation_event_links` row visible to both orgs.
- League fees: `federation_member_payers` (org-level payer profile → billing account + league-side contact person) then `PostgresInvoiceRepository.issue` in the league org.

## Ready for integration ranges
(none yet)

## Requests to other tracks
- C (wiring): mount `federationConsoleRoutes`/`federationConsoleNav` from `web/src/console/federation/` via nested feature-route discovery (or accept the minimal append to `web/src/console/routes.tsx` committed on this branch; drop it when discovery lands).
- C/notifications catalog owner: add federation notification types (`federation.relationship_invited`, `federation.entry_decided`, `federation.fee_invoiced`, `federation.discipline_issued`) — module emits no notifications until the catalog accepts them.
- G: when `scheduling`/`contests`/`standings`/`officials` services land, federation scheduling/results keep their league-scoped behavior; swap internals to the module services if they expose equivalent hooks. Federation uses `shared/src/algorithms/schedule-generator` directly today.
- K: federation demo seed helper is `server/src/modules/federation/demo.ts` (association + 2 member clubs scenario); call it from the Phase 15 `demo` profile seed for Metro Youth Sports Association.
- E: league-fee invoices currently use `source='staff'` and line kind `team_fee`; if a `federation_fee` enum value is added to `invoices.source`/`invoice_lines.kind`, federation should adopt it (see DECISIONS).

## Blocked on
Nothing hard-blocking; Track G scheduling/contests services are not on trunk yet — building against spine tables + shared algorithms per contract.
