# Track J — Phase 13 Federation

Status: Phase 13 shipped on `rebuild/trunk` at `9381acd1`; the Linux federation CI follow-up is included in the locally validated `rebuild/trunk` merge candidate.
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
- Federation Playwright acceptance journey in `mcr.microsoft.com/playwright:v1.63.0-noble` (`linux/amd64`, `CI=true`, `TZ=UTC`, one worker): Chromium and WebKit both exited 0 after one retry each. The x86 image ran under ARM-host emulation, so native x86 GitHub Actions remains authoritative.
- Locked merge candidate based on `84c85f8d`: typecheck and lint passed; full unit/integration suite passed with 969 passed and 1 skipped (970 total, 272 files passed and 1 skipped) against the isolated J Postgres at port 6432; full Chromium project in Linux ARM64 exited 0 with 37 passed, 9 flaky retries, and 6 skipped; production build passed. The local E2E worker starts with the lock-pinned `pg-boss` 12.1.1 dependency and reported `worker ready`.
- Combined trunk gate at `9381acd1`: typecheck, lint, and Knip passed; 880/880 unit and integration tests passed; 74 Playwright cases passed across Chromium and WebKit with 16 existing conditional skips; production build passed; main bundle measured 143.71 KB gzip against the 200 KB budget.
- After syncing `rebuild/trunk` through `cfe4c7c9`, `server/test/federation.test.ts` passed 19/19; typecheck and lint passed. The Linux CI trace showed `getByRole('group').first()` in `inviteClub` selecting the shell's earlier “Some panels are unavailable to your role” group instead of the “Proposed data-sharing agreement” fieldset; the locator now targets the fieldset by accessible name. The trace also showed startup requests receiving plain-text 500 responses while Vite was available before the proxied API; the E2E journey now waits for API `/readyz` to return `{ ready: true }` before navigation and gives the initial heading assertion 15 seconds. The latest Linux Playwright 1.63.0 Noble run on `cfe4c7c9` passed Chromium and WebKit (2/2, 49.7 seconds, `CI=true TZ=UTC`, one worker). An additional `linux/amd64` run under ARM-host emulation passed Chromium; WebKit passed on retry after a target crash during the final axe scan at the standings screen. Two earlier ARM64 runs also passed cleanly (48.8 and 54.1 seconds). Native x86_64 GitHub CI remains the authoritative runner check.
- Full `npm test` on `cfe4c7c9` had 959 passed, 1 skipped, and 4 failing tests: `peopleFilters.test.ts` violates `roster_entries_check`; both classes promotion cases violate `class_enrollments_check`; the sponsors placement integration test returns no placement. Four additional DB suites timed out in `server/test/setup.ts` cleanup hooks while both heavy slots were occupied. Track A owns people filters, Track I owns classes, and Track H owns sponsors; the federation integration file remains green (19/19).
- The Linux schedule-stats repro under the same UTC browser settings received “postpone 0 affected events” where the test expects one; the facility timezone root cause and precise fix request are recorded in Track G's “Requests from J”. This is outside Track J's owned code.
- The initial all-project Playwright run on J's isolated stack had 56 passes, 14 failures, and 16 skips because email-dependent specs hit Track A's SMTP mapping on port 9025. The final combined trunk gate passed with an isolated stack and the Track J journey passed in both browsers.
- Cross-timezone bug note recorded in Track G's request section: the hosted schedule journey's Chicago window was previously interpreted in UTC CI, causing no games to be generated.

## Requests from OPS

- **Track J (Knip, 2026-09-27):** resolved in `9381acd1`: the federation demo seed is wired to the demo profile, the federation navigation is consumed by the console, and the combined Knip gate passes.

## Requests to other tracks
- C (wiring): resolved in `9381acd1`; nested route discovery registers and mounts `consoleFederationRoutes`, and the console navigation includes a Federation entry for organizations with access.
- C/notifications catalog owner: add federation notification types (`federation.relationship_invited`, `federation.entry_decided`, `federation.fee_invoiced`, `federation.discipline_issued`) if federation notifications are included in the platform catalog. They are not part of the Phase 13 acceptance criteria, so the module currently emits none.
- G: federation adapts accepted external-team entries and contributed windows into G's `runScheduleGeneration` service, and uses G's `insertSpaceBooking` helper when applying hosted games. Cross-club contest results, standings, and official assignments still use federation-owned adapters because G's current services expect organization-local team membership; expose cross-org hooks if those services are extended for league ownership.
- K: the federation demo helper is `server/src/modules/federation/demo.ts` (association + two member clubs). K rechecked it against a clean, fully migrated database: `seedDemo` completes, then `seedFederationDemo` fails through `listLeagueContests` at `server/src/modules/federation/results.ts:657` with `syntax error at or near ")"`. When no `federation_event_links` exist, the organization-name query builds `WHERE id IN ()`; guard the empty list and add a regression test. K removed this optional helper call from the Phase 15 `demo` profile because K's profile already creates Metro's two member-club relationships, accepted inter-club entries, and eight officials with `team_entries`-only sharing per DEC-135.
- E: league-fee invoices currently use `source='staff'` and line kind `team_fee`; if a `federation_fee` enum value is added to `invoices.source`/`invoice_lines.kind`, federation should adopt it (see DECISIONS).

## Requests from QA

- QA-ACC-034: extend the relationship lifecycle integration test to end an active relationship, then assert previously allowed cross-org roster/team/compliance reads fail with 404 immediately. Current lifecycle assertions stop at ended status and audit evidence; the existing access-denial test covers suspension only. See `docs/codex/qa/DEFECTS.md`.
- QA-SEC-007: add real-Postgres outsider-denial assertions for the explicit two-party RLS policies on `org_relationships` and `federation_event_links`; the generic tenant inventory omits tables without `org_id`, and no unrelated-organization test covers these policies. See `docs/codex/qa/DEFECTS.md`.
- QA-SEC-008: add a real-Postgres privacy regression for `readMemberCompliance`: assert the status-only field allow-list, denied response when `compliance_status` is not shared, and dual-org audit for permitted reads. The dashboard reaches this path indirectly, but the test does not assert the privacy/audit contract. See `docs/codex/qa/DEFECTS.md`.
- QA-ACC-035: add an additive migration that corrects the `federation_sharing_guard()` JSON allow-list to the shared schema and service keys (`compliance_status`, `team_entries`); acceptance copies those snake_case proposal keys to `data_sharing`, while the current trigger only accepts camelCase variants. Keep applied `6000_federation.sql` unchanged and add a real-Postgres regression for every allowed sharing key. See `docs/codex/qa/DEFECTS.md`.
- QA-ACC-036: extend journey 25 to prove both member clubs' field windows influence generated output. It contributes both windows but has one team per club, `rounds: 1`, and asserts only one game, so it cannot detect one ignored window. Assert generated events on both club spaces or verify the merged generator input. See `docs/codex/qa/DEFECTS.md`.
- QA-SEC-012: QA runtime confirmed roster-derived counts remain visible after child-side immediate `rosters` sharing revocation. Make `listLeagueEntries()`, `getLeagueEntry()`, and `readMemberTeams()` recheck the active relationship and grant before returning cached snapshot fields. Active regression: `e2e/security/federation-sharing-revocation.spec.ts`.
- QA-ACC-046: QA runtime observed HTTP 500 while `voidFeeAssessment()` persisted `status='void'` and left the invoice open at 2500 cents. Make the assessment and invoice state transition atomic. Active regression: `e2e/phase13-fee-void-atomicity.spec.ts`.

## Blocked on
No Phase 13 behavior is blocked. The earlier red full suite on `cfe4c7c9` is cleared by trunk follow-up changes through `84c85f8d`; the locked merge candidate passed typecheck, lint, the full unit/integration suite, full Chromium project, and production build. The x86 Linux federation journey passed both projects after one retry each under local ARM emulation; native x86 GitHub Actions remains authoritative. Cross-club contest/results, standings, and official-assignment service reuse remains a follow-up if Track G adds cross-organization hooks. The schedule-stats timezone root cause and Track I's implementation are recorded in Track G.

Track J sprint complete

## Requests from I

- **Trunk verification (2026-09-27, `2c52eb47`):** `e2e/federation.spec.ts` passes 2/2 in Chromium desktop and WebKit mobile, and the class-family journey also passes 2/2, so federation routing/shell changes did not cause the reported academy failures. The earlier WebKit roster failure at `e2e/classes.spec.ts:267` was an inaccessible-name assertion against a mobile DataTable spanning cell: its visible `Enrollment type` label and `makeup` value were present, but the cell had no computed name. The assertion now checks the visible label and exact value; both browsers pass.
- Track C owns Console Home, which has no federation shortcut; that wiring request is outside J-owned paths and does not block Phase 13 acceptance.
