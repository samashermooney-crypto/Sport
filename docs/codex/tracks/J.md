# Track J — Phase 13 Federation

Status: ready for integration; final trunk integration pending
Branch: `track/j-federation`
Worktree: `/Users/sammooney/Sport-j-federation`
Stack: `COMPOSE_PROJECT_NAME=athlentry_j`, `PORT_OFFSET=1000` (Postgres 6432; local Playwright override maps Mailpit API to 9825 because 9025 is occupied by Track A's Mailpit SMTP port).

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
`server/src/modules/federation/**`, `web/src/console/federation/**`, federation-owned tests, and migrations `6000–6999`.

## Validation
- Federation integration tests: 19/19 passed, including per-facility timezone selection and organization-timezone fallback.
- Federation Playwright acceptance journey: passed in Chromium desktop and WebKit mobile with the browser set to UTC; axe checks passed.
- Full unit/integration suite: 874 passed, 1 pre-existing skipped; production build passed.
- All-project Playwright attempt: 56 passed, 14 failed, 16 skipped. The Phase 13 journey passed in both projects. Email-dependent specs hit `127.0.0.1:9025`, which is Track A's SMTP mapping; J's Mailpit API is mapped to 9825 to avoid the collision. Other failures were in unrelated WebKit journeys.
- Cross-timezone bug note recorded in Track G's request section: the hosted schedule journey's Chicago window was previously interpreted in UTC CI, causing no games to be generated.

## Requests from OPS

- **Track J (Knip, 2026-09-27):** resolve or wire unused `server/src/modules/federation/demo.ts` and `web/src/console/federation/nav.ts`, and remove or consume `expandAvailabilityWindows` and `withFederationAccess`; `npm run knip` reports them on updated `rebuild/trunk`. If console navigation belongs in the central shell, coordinate that link with Track C. OPS did not modify J-owned files.

## Requests to other tracks
- C (wiring): nested route discovery now registers `consoleFederationRoutes` in `web/src/generated/nested-routes.ts`, and `web/src/app.tsx` mounts those routes. The federation `nav.ts` is not part of that nested route registry, and `web/src/console/Home.tsx` has no federation entry point; include the nav item or a link to `/console/federation/:orgId` for organizations with federation access. Track J does not own the console home, app router, or generated registries.
- C/notifications catalog owner: add federation notification types (`federation.relationship_invited`, `federation.entry_decided`, `federation.fee_invoiced`, `federation.discipline_issued`) if federation notifications are included in the platform catalog. They are not part of the Phase 13 acceptance criteria, so the module currently emits none.
- G: federation adapts accepted external-team entries and contributed windows into G's `runScheduleGeneration` service, and uses G's `insertSpaceBooking` helper when applying hosted games. Cross-club contest results, standings, and official assignments still use federation-owned adapters because G's current services expect organization-local team membership; expose cross-org hooks if those services are extended for league ownership.
- K: federation demo seed helper is `server/src/modules/federation/demo.ts` (association + 2 member clubs scenario); call it from the Phase 15 `demo` profile seed for Metro Youth Sports Association.
- E: league-fee invoices currently use `source='staff'` and line kind `team_fee`; if a `federation_fee` enum value is added to `invoices.source`/`invoice_lines.kind`, federation should adopt it (see DECISIONS).

## Requests from QA

- QA-ACC-034: extend the relationship lifecycle integration test to end an active relationship, then assert previously allowed cross-org roster/team/compliance reads fail with 404 immediately. Current lifecycle assertions stop at ended status and audit evidence; the existing access-denial test covers suspension only. See `docs/codex/qa/DEFECTS.md` (2026-09-27).
- QA-SEC-007: add real-Postgres outsider-denial assertions for the explicit two-party RLS policies on `org_relationships` and `federation_event_links`; the generic tenant inventory omits tables without `org_id`, and no unrelated-organization test covers these policies. See `docs/codex/qa/DEFECTS.md` (2026-09-27).
- QA-SEC-008: add a real-Postgres privacy regression for `readMemberCompliance`: assert the status-only field allow-list, denied response when `compliance_status` is not shared, and dual-org audit for permitted reads. The dashboard reaches this path indirectly, but the test only checks aggregates and does not assert the privacy/audit contract. See `docs/codex/qa/DEFECTS.md` (2026-09-27).
- QA-QUAL-001: triage federation's current Knip findings: `server/src/modules/federation/demo.ts` is pending the Track K demo-seed integration; `federationConsoleNav`, `expandAvailabilityWindows`, and `withFederationAccess` are unused exports. Wire intended APIs or remove dead exports, and coordinate the demo seed with K. See `docs/codex/qa/DEFECTS.md` (2026-09-27).
- QA-ACC-035: add an additive migration that corrects the `federation_sharing_guard()` JSON allow-list to the shared schema and service keys (`compliance_status`, `team_entries`); acceptance copies those snake_case proposal keys to `data_sharing`, while the current trigger only accepts camelCase variants. Keep applied `6000_federation.sql` unchanged and add a real-Postgres regression for every allowed sharing key. QA runtime verification is blocked by the port-1500 stack collision. See `docs/codex/qa/DEFECTS.md` (2026-09-27).
- QA-ACC-036: extend journey 25 to prove both member clubs' field windows influence generated output. It contributes both windows but has one team per club, `rounds: 1`, and asserts only one game, so it cannot detect one ignored window. Assert generated events on both club spaces or verify the merged generator input directly. See `docs/codex/qa/DEFECTS.md` (2026-09-27).
- QA-SEC-012: make `listLeagueEntries()`, `getLeagueEntry()`, and `readMemberTeams()` recheck the active relationship and current `rosters` grant before returning cached snapshot fields. After a child-side immediate roster-sharing revocation, preserve team-entry metadata if `team_entries` remains enabled but omit roster counts and player data; suspension/end must also stop reads. Regression is marked `test.fixme` in `e2e/security/federation-sharing-revocation.spec.ts`. See `docs/codex/qa/DEFECTS.md` (2026-09-27).
- QA-ACC-046: prevent `voidFeeAssessment()` from committing `status='void'` before `PostgresInvoiceRepository.void()` succeeds. An active installment or net payment causes invoice validation to reject the void in its separate transaction, leaving a void assessment attached to a payable invoice. Regression is marked `test.fixme` in `e2e/phase13-fee-void-atomicity.spec.ts`. See `docs/codex/qa/DEFECTS.md` (2026-09-27).

## Blocked on
Track J reports no Phase 13 behavior is blocked: the nested route is mounted and its federation journey passed in Chromium and mobile WebKit with axe checks. Its lock-protected trunk merge gate remains pending because other browser specs hit the occupied Mailpit port described above. QA's post-merge review has recorded QA-ACC-034, QA-ACC-046, QA-SEC-007–008, QA-SEC-012, and QA-ACC-035–036: ended-relationship revocation and third-party RLS denial need direct coverage, compliance status-only privacy needs a direct regression, cached league entry reads ignore revoked roster sharing, rejected fee-invoice voids leave inconsistent state, the sharing-trigger key fix needs real-Postgres verification, and the one-game journey cannot prove both clubs' availability affects output. QA browser and DB checks remain blocked by the port-1500 collision with Track I. Track C owns the missing Console Home Federation shortcut (QA-ACC-033). Cross-club contest/results, standings, and official-assignment service reuse remains a follow-up if Track G adds cross-organization hooks.

Track J sprint complete
