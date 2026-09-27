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
- Roster snapshot exposure is limited to name, age label, jersey, positions, card number, and photo availability; DOB/birth year and media-consent details never cross the boundary. A private file id is retained only for currently consented photos, and reads recheck current consent.
- Snapshot contents are immutable after submission; entry status, freeze state, and version remain mutable through federation services. The already-applied `6000_federation.sql` stays unchanged; the protection is an additive `6001_federation_snapshot_privacy.sql` migration.
- Cross-org roster and team reads use only accepted submitted league entries. Compliance sharing returns derived status only. League owner-email discovery matches an exact email internally, never returns it, and audits both the requesting and candidate organizations.
- Read responses and status transitions never expose another organization's private teams or raw member compliance documents. Photo reads require the roster sharing key, an active relationship, a private retained file id, and live media consent.

## Ready for integration ranges
(none yet)

## Requests to other tracks
- C (wiring): register nested `web/src/console/federation/routes.tsx` and `nav.ts` in the generated web registry, and ensure the console shell links to `/console/federation/:orgId`. `web/src/generated/registry.ts` currently only imports the root console aggregator, so the federation console and its E2E route are unreachable until C wires nested features. Track J does not own the router or generated registry.
- C/notifications catalog owner: add federation notification types (`federation.relationship_invited`, `federation.entry_decided`, `federation.fee_invoiced`, `federation.discipline_issued`) — module emits no notifications until the catalog accepts them.
- G: expose the scheduling, contest/result, standings, and official assignment service hooks for cross-org league ownership. Federation uses `shared/src/algorithms/schedule-generator` directly today and keeps all resulting data league-scoped; replace internals where equivalent Track G services are available.
- K: federation demo seed helper is `server/src/modules/federation/demo.ts` (association + 2 member clubs scenario); call it from the Phase 15 `demo` profile seed for Metro Youth Sports Association.
- E: league-fee invoices currently use `source='staff'` and line kind `team_fee`; if a `federation_fee` enum value is added to `invoices.source`/`invoice_lines.kind`, federation should adopt it (see DECISIONS).

## Blocked on
The federation console E2E journey and browser acceptance check are blocked until Track C mounts the nested federation route in the generated console registry. Track G's scheduling/contests/standings/officials services were not present when this implementation was built, so the module currently uses the documented league-scoped spine tables and shared schedule algorithm.
