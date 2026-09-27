# Track J — Phase 13 Federation

Status: done
Branch: `track/j-federation`
Worktree: `/Users/sammooney/Sport-j-federation`
Stack: `COMPOSE_PROJECT_NAME=athlentry_j`, `PORT_OFFSET=1000` (Postgres 6432; local Playwright override maps Mailpit API to 9825 because 9025 is occupied).

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
Integrated to `rebuild/trunk` by this merge: `server/src/modules/federation/**`, `web/src/console/federation/**`, federation-owned tests, and migrations `6000–6999`.

## Requests to other tracks
- C (wiring): nested route discovery now registers `consoleFederationRoutes` in `web/src/generated/nested-routes.ts`, and `web/src/app.tsx` mounts those routes. The federation `nav.ts` is not part of that nested route registry, and `web/src/console/Home.tsx` has no federation entry point; include the nav item or a link to `/console/federation/:orgId` for organizations with federation access. Track J does not own the console home, app router, or generated registries.
- C/notifications catalog owner: add federation notification types (`federation.relationship_invited`, `federation.entry_decided`, `federation.fee_invoiced`, `federation.discipline_issued`) if federation notifications are included in the platform catalog. They are not part of the Phase 13 acceptance criteria, so the module currently emits none.
- G: federation adapts accepted external-team entries and contributed windows into G's `runScheduleGeneration` service, and uses G's `insertSpaceBooking` helper when applying hosted games. Cross-club contest results, standings, and official assignments still use federation-owned adapters because G's current services expect organization-local team membership; expose cross-org hooks if those services are extended for league ownership.
- K: federation demo seed helper is `server/src/modules/federation/demo.ts` (association + 2 member clubs scenario); call it from the Phase 15 `demo` profile seed for Metro Youth Sports Association.
- E: league-fee invoices currently use `source='staff'` and line kind `team_fee`; if a `federation_fee` enum value is added to `invoices.source`/`invoice_lines.kind`, federation should adopt it (see DECISIONS).

## Blocked on
No Phase 13 acceptance blocker remains. The nested route is mounted and the federation journey passes in Chromium and mobile WebKit with axe checks. Track C owns Console Home, which has no federation shortcut; that wiring request remains outside the paths owned by J and does not block the Phase 13 acceptance criteria. Cross-club contest/results, standings, and official-assignment service reuse remains a follow-up if Track G adds cross-organization hooks.

Track J sprint complete
