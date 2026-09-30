# Track I — academy / class mode (Phase 12)

Status: Phase 12 complete; Phase 16 §1 security acceptance in progress
Model: Codex (GPT-6 Luna XH)
Branch: `track/i-academy`
Worktree: `/Users/sammooney/Sport-i-academy`
Owns: `server/src/modules/classes/**`, `web/src/console/classes/**`, `web/src/portal/classes/**`, own tests, migrations 5000–5999, this file.

## Completion

- Academy backend, console, family portal and both nested routes are implemented, registered, documented in OpenAPI and merged to `rebuild/trunk`.
- Gate: typecheck, lint and build pass; full Vitest 837 passed / 1 skipped; Chromium 31 passed / 4 skipped; focused academy DB 17/17, family screen 1/1 and schema spine 4/4 pass.
- `e2e/classes.spec.ts` cross-browser regression (2026-09-27): WebKit mobile renders roster fields in DataTable's mobile-card row, where the label and value are visible inside a spanning cell but the cell has no computed accessible name. The assertion now checks the visible `Enrollment type` label and exact `makeup` value in Taylor's row; Chromium desktop and WebKit mobile both pass after syncing through `0ca39573`.
- CI run `36362797999` class-integration root cause: `thisMonthRange()` used the UTC date from `toISOString()` while the fixture organizations and class service use `America/Chicago`. At 2026-09-28 01:14 UTC, UTC had advanced to Sep 28 but the org-local date was Sep 27, producing invalid date fixtures. The helper now uses `orgToday()` with the fixture timezone and has a deterministic midnight-boundary regression test; the seven-failure incident is resolved and the current class suite passes 19/19 on `d52e4c83`. The `6e73bda8`→`2c52eb47` trunk delta contains no Phase 3 class/date change, so no Track B runtime fix was needed; the finding is recorded in `B.md` as requested.
- The first no-commit merge gate on `cfe4c7c9` exposed two more UTC/date-only fixture bugs: `peopleFilters.test.ts` used the database's UTC `CURRENT_DATE` for `joined_on` but a Chicago-local `left_on`, and the sponsor placement test computed its contract start with UTC `toISOString()` while production correctly uses `orgToday()`. Both fixtures now use valid, organization-local dates; no roster or sponsor production behavior changed.
- Trunk E2E checks (2026-09-27): federation passes 2/2 and classes passes 2/2 across Chromium desktop and WebKit mobile. On trunk baseline 2c52eb47, schedule-stats passes WebKit but Chromium reports `postpone 0 affected events`; on the I branch with `62234e54`, all three journeys pass 6/6 when run serially across both browsers.
- Phase 12 promotion acceptance is asserted in PostgreSQL integration coverage: approval creates the guardian's in-app notification, and a subscribed promotion moves billing to the target offering's tuition tier on the next bill without adding a duplicate same-month invoice.
- Phase 12 ratio monitoring is asserted in PostgreSQL integration coverage: a 9-athlete scheduled class at an 8:1 ratio with one active instructor appears in the dashboard warnings with two instructors required.

## Request from K (2026-09-28)

- On K's full-suite run, `server/src/modules/classes/classes.integration.test.ts` fails “recommends, approves and confirms a promotion” and “defers a subscribed level change to the next bill without double charging” at `server/src/modules/classes/promotions.ts:347`. The code sets the source enrollment's `ends_on=today` even when `starts_on` is in the future, violating migration 5001's `starts_on <= ends_on` check. Preserve a valid enrollment interval while avoiding duplicate billing, and add regression coverage for future-start enrollment promotion.

## Requests to other tracks

- **C (navigation, 2026-09-27):** add a family-portal Classes link in `PortalShell`. The current nested-route generator now registers `/console/orgs/:orgId/classes` and `/me/orgs/:orgId/classes` without changes to central aggregators.
- **C (stack, 2026-09-27):** I's prescribed `PORT_OFFSET=900` collides with C's active mailpit/Postgres/Stripe listeners (including `127.0.0.1:1925`); I isolated work at offset 1500 and requests a free, stable offset or release of 900 before the final gate.
- **B (program listing, 2026-09-27):** expose published programs filtered by `mode=class` to replace the functional program-ID field with a picker; current Programs API is not present in I's merged trunk.
- **F (compliance):** `role_credential_requirements.role` still has no `instructor`; class instructor and substitute checks use existing `head_coach`/DEC-080 contract until F adds the instructor role.
- **K (Phase 15 seed):** seed Northstar Gymnastics & Swim Academy with class-mode program, 40 classes, 300 students, tuition tiers, skills and schedules.
- **G (scheduling):** ensure facility closure/blackout changes cancel or flag materialized `class_session` events; I's schedule generator skips registered holidays/blackouts at creation time.
- **C (SEC-002 fixture fidelity, 2026-09-28):** C branch `f0c6634f` publishes metadata and enables the 152-operation fuzzer, but `tenancy-fuzz.spec.ts` still substitutes the foreign org ID in each route and random UUIDs for child IDs except files; generated tenancy fixtures currently carry body/query data and `pathResource: 'file'` only. DEC-114 requires existing foreign child-resource IDs under the caller's own org path. Add path-resource fixture metadata/seed rows and update the fuzzer to use them before marking all-route fuzz complete. I's class journey now covers an existing foreign offering on direct and nested routes.
- **C (launch-gate security evidence, 2026-09-28):** refresh `LAUNCH-GATE.md` item 6 against `d52e4c83`. Gitleaks, SSRF and session-fixation checks are enabled and passed locally; only the three SEC-002 route-authorization, permission-matrix and tenancy-fuzz specs remain `test.fixme`. Hosted CI status is still unobserved locally.
- **E (full-suite UUID edge case, 2026-09-28):** `stableUuid()` in `server/src/modules/registration/team-entries.ts` treats a valid zero SHA-256 byte as an incomplete digest. `team-entries.test.ts` failed in three UTC full-suite runs (including the 2-worker merge gate after `d52e4c83`) and passed once on a focused rerun; validate digest length rather than byte truthiness to remove the intermittent gate failure.

## Requests from QA

- QA-INC-001 (2026-09-28): a QA Chromium attempt used Track I Postgres on port 6932 because the test fixtures derived the DB URL directly from `PORT_OFFSET=1500` while the QA app was on its remapped 16932 database. The run was interrupted after 19 passes; synthetic test fixtures may have been inserted into `athlentry_i`. QA did not inspect or delete I data. Please inspect the isolated I database and remove only clearly identified QA test fixtures if safe; details are in `docs/codex/tracks/QA.md`.
- QA test-stack unblock (2026-09-27): release or move I's active Docker stack from `PORT_OFFSET=1500` so QA can run its required database and Chromium gates on its assigned offset. QA confirmed its Playwright web server exits before test collection while I owns Postgres `6932`, Mailpit `2525/9525`, and Stripe mock `13611`; QA will not stop I's containers.
- QA-SEC-010 (2026-09-28): QA runtime confirmed the waitlist endpoint returned two entries after guardian-link revocation. Revalidate the active verified guardian/self link when listing, accepting, or declining entries. The active regression is `e2e/security/class-waitlist-revoked-guardian.spec.ts`.
- QA-SEC-011 (2026-09-27): enforce current verified person links and record ownership on `GET /me/punch-cards`, booking cancellation, and punch-card redemption. Those paths can expose a revoked guardian's child/card or let any active org member mutate a known booking/card UUID. The active regression is `e2e/security/class-booking-guardian-idor.spec.ts`.
- QA-SEC-013 (2026-09-28): QA runtime confirmed an unlinked same-org member received HTTP 200 and age-filtered classes for the child's person ID. Require a current verified self/guardian link before `/me/browse?personId=...` uses that person's DOB. The active regression is `e2e/security/class-browse-person-link.spec.ts`.
- QA-SEC-014 (2026-09-28): QA runtime confirmed a non-member guardian linked to an instructor received HTTP 200 and the session roster. Require the assigned instructor's own verified self link rather than any active relationship. The active regression is `e2e/security/class-instructor-guardian-roster.spec.ts`.
- QA-SEC-015 (2026-09-28): QA runtime confirmed a forged same-org household drop-in returned 201 and persisted under the unrelated household. Validate `householdId` against the linked person for drop-ins and punch-card purchases. Active regression: `e2e/security/class-booking-guardian-idor.spec.ts`; details in `docs/codex/qa/DEFECTS.md`.

## Requests from OPS

- **Track I (Knip, 2026-09-27):** resolve or wire the two unused academy nav files and 37 unused exports/types reported by `npm run knip` on updated `rebuild/trunk`, so the CI Knip gate is green. Findings are also listed under SEC-KNIP-I; OPS did not modify I-owned files.
- **Track I (promotion integration, 2026-09-27):** both promotion tests fail reproducibly because the update at `server/src/modules/classes/promotions.ts:347` violates `class_enrollments_check`; correct the promotion state transition so enrollment status/date invariants hold.
- **Track I (Knip, 2026-09-27):** the latest OPS run additionally reports unused `web/src/console/evaluations/nav.ts` and `web/src/portal/evaluations/nav.ts`; wire these routes or remove the unused files so the Knip gate is green. OPS did not modify I-owned files.

## Requests from SEC

- SEC-KNIP-I: triage current Knip findings in I-owned class paths: unused `web/src/console/classes/nav.ts` and `web/src/portal/classes/nav.ts`; exports `requireSessionInstructor`, `ageMonths`, `nextMonthBillingDate`, `stripExceptions`, `materializeScheduleSessions`, `deterministicUuid`, `mandateHashFor`, `billSubscription`; shared schemas `classBillingSchema`, `tuitionTiersSchema`, `makeupPolicySchema`, `instructorSchema`, `enrollmentStatusSchema`, `waitlistEntrySchema`, `sessionAttendanceSchema`, `skillRecordStatusSchema`, `athleteSkillRecordSchema`, `classesErrorCodes`; types `ClassBilling`, `MakeupPolicy`, `WaitlistEntry`, `AttendanceMark`, `SessionAttendance`, `CheckOutBody`, `BookMakeupBody`, `PunchCardPurchase`, `DropInBody`, `SubscriptionUpdate`, `SyncLevelsBody`, `SkillRecordStatus`, `AthleteSkillRecord`, `RecordSkillBody`, `SessionSkillMarks`, `RecommendPromotion`, `PromotionDecision`, `WithdrawResult`, and `ResumeBody` (2026-09-27).

## Blocked on

Phase 12 acceptance is complete. Phase 16 §1 remains open pending Track C's SEC-002 metadata, true foreign child-resource fixtures and reviewed role matrix landing on trunk, plus hosted Gitleaks CI evidence. On `d52e4c83`, the full suite passed 987 tests with 1 existing skip and Chromium passed 50 with 3 SEC-002 cases still skipped. A later I merge attempt was correctly aborted when the full suite reproduced E's `team-entries.test.ts` UUID digest failure; I's focused class PostgreSQL and Chromium security journeys pass. The portal shell link and other Phase 12 track-owned follow-ups remain requested above.

## Decisions taken

- DEC-109: instructor and substitute eligibility use the existing `head_coach` policy until compliance adds `instructor`.
- DEC-110: monthly tuition autopay requires explicit subscription consent and an invoice-scoped authorization.
- DEC-111: pickup requires an active household permission or verified family links, with check-in required first.
- DEC-112: enrollment locks the offering; session bookings lock the `class_session` capacity counter.
- DEC-113: level promotions defer tuition changes by default and settle only the household's remaining-session delta when immediate.
- I temporarily used `PORT_OFFSET=1500` because the required 900 was occupied; no other track's containers were stopped or changed.

## Phase 16 §1 security work

- SEC-002 class-resource and CSRF coverage: the Chromium journey reads owned offering/schedule/waitlist lists (200), requires 404 for direct offering GET and schema-valid PATCH, nested schedule/waitlist GETs, schedule PATCH/instructor reads, session/roster/pickup reads, level GET/PATCH, skill PATCH, and athlete-progress reads against existing foreign resources under the actor's organization, verifies the foreign offering is unchanged, and requires 403 for a missing request marker or hostile Origin. The expanded journey passes 1/1 and the class PostgreSQL suite passes 19/19 on the current I branch; the `d52e4c83` Chromium merge gate passed 50 with the 3 SEC-002 contract-dependent cases still skipped.
- SEC-005 (Auth / Track A): `/step-up` atomically replaces the cookie or bearer session after password/TOTP verification, and revokes the prior token. MFA enrollment confirmation and step-up now share the MFA request limiter. Auth security/routes integration tests and the Chromium fixation journey pass.
- SEC-SSRF-C-001 (Push / Track C): Web Push endpoints are limited to supported provider hosts, all DNS answers are checked against non-public ranges, and an HTTPS agent pins delivery to the vetted address. Sender tests (11/11) and the Chromium SSRF journey pass.
- SEC-CI-001 (CI / Track C): the Gitleaks workflow job and enabled source assertion are present; hosted CI status remains unobserved locally.
- SEC-002 route metadata, role matrix, and true foreign-resource fixtures remain open on Track C. DEC-114 prohibits synthetic default metadata or random missing IDs being counted as authorization evidence; the security completeness journeys remain `test.fixme` until reviewed contracts exist.
