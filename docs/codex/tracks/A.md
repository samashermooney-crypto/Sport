# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Track A's People CRUD, derived age/grade, household membership, household/balance/program/team/credential-record filters, consent-aware photos and the ready B/C/D/E/F/H ranges are integrated on `rebuild/trunk`. The latest merged gate passed 723 tests and 42 browser tests plus typecheck, lint, build, size and generated-file freshness. Phase 1 tasks 4 and 16, Phase 2 role-aware compliance and later acceptance remain open. Track G has no ready range.
Ready for self-merge: adult self claims (`a5510a1`) and encrypted medical profiles (`9033a22`), both with focused PostgreSQL and Chromium gates. Trunk merge attempts were rolled back under the sprint lock after unrelated test hooks and finance property tests timed out under concurrent full-suite load; A will retry with bounded Vitest workers. The guardian emergency-contact editor and retained-contact migration are in progress. Athlete invitations and later Phase 2 acceptance remain. Track C owns wiring and PROGRESS.md.
Requests to other tracks: C — the trunk full suite repeatedly hit Vitest's default 10-second hook timeout across orgs, platform, communications, chat, compliance and audit plus the 20-second finance property limit under concurrent track load, while the same affected A tests passed on its isolated stack. Please account for concurrent full-gate contention in the hourly gate. Track A is testing a bounded-worker merge run; no assertion or timeout has been weakened.
Requests to other tracks: E — proceed with Phase 4 against the spine now on trunk.
Requests to other tracks: D — identity screens in task 3 are stable for your auth restyle queue; console Home in task 17 remains with A.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. Track C's SMTP port offset passes isolated browser tests.
Self-review: The Phase 1 tenancy matrix is derived from the documented Phase 1 OpenAPI routes, tests 32 organization paths and four account query aliases against a real second tenant, and verifies direct RLS isolation through `withOrg`.
Self-review: Account language updates require an authenticated session and verified write origin; the account page follows and saves the durable locale used by SMS consent, with Chromium/WebKit and database evidence.
Self-review: The platform area now shares the frozen AppShell and exposes only working Platform and Account links; its existing Chromium/WebKit operations journey remains accessible.
Self-review: People reads and writes run inside `withOrg`, require an active staff role except audited platform impersonation reads, reject impersonation writes, use versions for edits/archive/restore, and leave an audit trail. Remaining Phase 2 task 1 filters and media flows are tracked in PROGRESS.

## HANDOFF

Track A branch: `track/a-core` in `/Users/sammooney/Sport`. Current committed head before the final handoff marker: `1fa24d7`. The worktree is clean. No Track A commit in this handoff range has been merged to `rebuild/trunk` because the trunk merge gate repeatedly failed under concurrent full-suite load; each attempted merge was rolled back and its lock released. At the last check, trunk was `c10e989` and another track held the lock dated 08:13. Do not reintroduce the Track G merge that trunk previously reverted.

Done on A branch:
- `a5510a1` adult staff-issued, email-bound profile claims: real PostgreSQL and Chromium acceptance passed.
- `9033a22` encrypted medical profile API with audited, scoped guardian/staff/coach/registrar reads, versioned edits, and family/staff editor. Two real PostgreSQL tests and the 390 px guardian journey with axe passed.
- `b3934a2` retained, versioned emergency contacts: migration `db/migrations/0900_emergency_contact_retention.sql`, generated `server/src/db/types.ts`, API and family/staff editor. Two real PostgreSQL tests and the 390 px guardian contact save with axe passed. DEC-097–099 in `docs/codex/DECISIONS.md` cover the A decisions and the post-spine 0900 migration slot.
- The committed A branch passed `npm run typecheck`, affected real-Postgres tests and the focused Chromium journeys. Before the athlete WIP, `npm test -- --maxWorkers=2` passed 730 tests (one operator smoke skipped) in 199 passing files. The standard unbounded trunk `npm test` repeatedly timed out unrelated 10-second hooks (orgs, platform, communications, chat, compliance, audit) and the 20-second finance property test under concurrent load. A five-worker browser gate had four unrelated failures; each passed when rerun with two workers. The trunk gate remains red, so the engine-switch exception skips merging.

In progress (committed WIP `1fa24d7`, compiles; no feature tests yet): `server/src/modules/people/athleteLinks.ts` implements guardian-issued, person/email/DOB-bound 13–17 account invitations, redemption and revocation; `server/src/modules/people/routes.ts` and `module.ts` expose the API; `shared/src/schemas/people.ts` contains response schemas; `server/src/integrations/email/templates/auth.tsx` has bilingual invitation copy; `docs/api/openapi.json` is regenerated. The API was not browser exercised. No athlete invitation UI or acceptance page exists yet.

Next steps, in order:
1. Finish and test the athlete invitation WIP with real PostgreSQL: tenant denial; guardian authority at issue and redemption; age 13–17 and exact DOB; verified email and token binding/reuse; changed profile email; revoked guardian; final guardian invariant; delivery failure; revocation and session expiry. Fix any discovered service/API issue.
2. Add guardian controls to `web/src/people/FamilyMedical.tsx` via a new `web/src/people/AthleteAccess.tsx`, visible only for guardian-linked 13–17 profiles. Add `web/src/people/AcceptAthleteInvitation.tsx` and its route in `web/src/people/routes.tsx`. Extend `e2e/guardian-invitation.spec.ts` with the Mailpit acceptance, athlete read-only family view, guardian revocation, 390 px and axe journey. Regenerate OpenAPI after contract edits.
3. Complete Phase 1 tasks 4 and 16: native `PushManager.subscribe()` in a trusted browser is still unverified after local HTTPS reported permission denied; adopt remaining frozen shell/component and bilingual screen details against `docs/codex/10-PHASES-FOUNDATION.md`. Track D owns Linux visual-parity CI baselines.
4. Complete the remaining Phase 2 acceptance: role-aware People compliance, full household journey, family profile/photo/document editing, forms versioning/reuse, waivers and signed PDF, duplicate merge/conflict handling, 2,000-row mixed-date imports/rollback, and console search. Check every item against `docs/codex/10-PHASES-FOUNDATION.md`; Track C alone updates `docs/codex/PROGRESS.md` during sprint.
5. When Track C restores a green trunk, refresh A from its current head, regenerate generated files on conflicts, run the branch gate, acquire `/tmp/athlentry-trunk.lock`, self-merge A and run the full trunk gate. Use bounded parallel workers if load still causes unrelated timeouts; do not relax assertions or timeouts. Roll back a red merge and release the lock per SPRINT.md.

Open requests: Track C owns app/worker/router/registry wiring and hourly full gates; the existing request above reports default Vitest concurrency failures. Track D owns Linux design-parity baselines. No owner question is pending.

Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_a_identity`, `PORT_OFFSET=8000` (Postgres 13432). Real-Postgres tests use `DATABASE_ADMIN_URL=postgres://athlentry_admin@127.0.0.1:13432/athlentry_test` and `DATABASE_APP_URL=postgres://athlentry_app@127.0.0.1:13432/athlentry_test`. Browser tests use the same compose name and offset.
HANDED OFF 08:26
