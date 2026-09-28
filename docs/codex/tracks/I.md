# Track I — academy / class mode (Phase 12)

Status: I sprint complete
Model: Codex (GPT-6 Luna XH)
Branch: `track/i-academy`
Worktree: `/Users/sammooney/Sport-i-academy`
Owns: `server/src/modules/classes/**`, `web/src/console/classes/**`, `web/src/portal/classes/**`, own tests, migrations 5000–5999, this file.

## Completion

- Academy backend, console, family portal and both nested routes are implemented, registered, documented in OpenAPI and merged to `rebuild/trunk`.
- Gate: typecheck, lint and build pass; full Vitest 837 passed / 1 skipped; Chromium 31 passed / 4 skipped; focused academy DB 17/17, family screen 1/1 and schema spine 4/4 pass.
- `e2e/classes.spec.ts` cross-browser regression (2026-09-27): WebKit mobile renders roster fields in DataTable's mobile-card row, where the label and value are visible inside a spanning cell but the cell has no computed accessible name. The assertion now checks the visible `Enrollment type` label and exact `makeup` value in Taylor's row; Chromium desktop and WebKit mobile both pass after syncing through `0ca39573`.

## Requests to other tracks

- **C (navigation, 2026-09-27):** add a family-portal Classes link in `PortalShell`. The current nested-route generator now registers `/console/orgs/:orgId/classes` and `/me/orgs/:orgId/classes` without changes to central aggregators.
- **C (stack, 2026-09-27):** I's prescribed `PORT_OFFSET=900` collides with C's active mailpit/Postgres/Stripe listeners (including `127.0.0.1:1925`); I isolated work at offset 1500 and requests a free, stable offset or release of 900 before the final gate.
- **B (program listing, 2026-09-27):** expose published programs filtered by `mode=class` to replace the functional program-ID field with a picker; current Programs API is not present in I's merged trunk.
- **F (compliance):** `role_credential_requirements.role` still has no `instructor`; class instructor and substitute checks use existing `head_coach`/DEC-080 contract until F adds the instructor role.
- **K (Phase 15 seed):** seed Northstar Gymnastics & Swim Academy with class-mode program, 40 classes, 300 students, tuition tiers, skills and schedules.
- **G (scheduling):** ensure facility closure/blackout changes cancel or flag materialized `class_session` events; I's schedule generator skips registered holidays/blackouts at creation time.

## Requests from QA

- QA test-stack unblock (2026-09-27): release or move I's active Docker stack from `PORT_OFFSET=1500` so QA can run its required database and Chromium gates on its assigned offset. QA confirmed its Playwright web server exits before test collection while I owns Postgres `6932`, Mailpit `2525/9525`, and Stripe mock `13611`; QA will not stop I's containers.
- QA-SEC-010 (2026-09-27): revalidate the active verified guardian/self link when listing, accepting, or declining class waitlist entries; account-bound entries remain visible after a child link is revoked. Regression: `e2e/security/class-waitlist-revoked-guardian.spec.ts` (`test.fixme` pending the authorization fix).
- QA-SEC-011 (2026-09-27): enforce current verified person links and record ownership on `GET /me/punch-cards`, booking cancellation, and punch-card redemption. Those paths can expose a revoked guardian's child/card or let any active org member mutate a known booking/card UUID. Regression: `e2e/security/class-booking-guardian-idor.spec.ts` (`test.fixme` pending the authorization fix).
- QA-SEC-013 (2026-09-27): require a current verified self/guardian link before `/me/browse?personId=...` uses that person's DOB to filter age-banded classes. Any active organization member can currently infer the child's age band from the returned offerings. Regression: `e2e/security/class-browse-person-link.spec.ts` (`test.fixme` pending the authorization fix).
- QA-SEC-014 (2026-09-27): prevent a guardian link to an assigned adult instructor from inheriting that instructor's session-roster access. The roster guard accepts any active `person_account_links` relationship and does not require the instructor account's verified self link; a non-member guardian can receive attendee names and IDs. Regression: `e2e/security/class-instructor-guardian-roster.spec.ts` (`test.fixme` pending the authorization fix).

## Requests from OPS

- **Track I (Knip, 2026-09-27):** resolve or wire the two unused academy nav files and 37 unused exports/types reported by `npm run knip` on updated `rebuild/trunk`, so the CI Knip gate is green. Findings are also listed under SEC-KNIP-I; OPS did not modify I-owned files.

## Requests from SEC

- SEC-KNIP-I: triage current Knip findings in I-owned class paths: unused `web/src/console/classes/nav.ts` and `web/src/portal/classes/nav.ts`; exports `requireSessionInstructor`, `ageMonths`, `nextMonthBillingDate`, `stripExceptions`, `materializeScheduleSessions`, `deterministicUuid`, `mandateHashFor`, `billSubscription`; shared schemas `classBillingSchema`, `tuitionTiersSchema`, `makeupPolicySchema`, `instructorSchema`, `enrollmentStatusSchema`, `waitlistEntrySchema`, `sessionAttendanceSchema`, `skillRecordStatusSchema`, `athleteSkillRecordSchema`, `classesErrorCodes`; types `ClassBilling`, `MakeupPolicy`, `WaitlistEntry`, `AttendanceMark`, `SessionAttendance`, `CheckOutBody`, `BookMakeupBody`, `PunchCardPurchase`, `DropInBody`, `SubscriptionUpdate`, `SyncLevelsBody`, `SkillRecordStatus`, `AthleteSkillRecord`, `RecordSkillBody`, `SessionSkillMarks`, `RecommendPromotion`, `PromotionDecision`, `WithdrawResult`, and `ResumeBody` (2026-09-27).

## Blocked on

None for Track I-owned Phase 12 acceptance. The portal shell link and other track-owned follow-ups remain requested above.

## Decisions taken

- DEC-109: instructor and substitute eligibility use the existing `head_coach` policy until compliance adds `instructor`.
- DEC-110: monthly tuition autopay requires explicit subscription consent and an invoice-scoped authorization.
- DEC-111: pickup requires an active household permission or verified family links, with check-in required first.
- DEC-112: enrollment locks the offering; session bookings lock the `class_session` capacity counter.
- DEC-113: level promotions defer tuition changes by default and settle only the household's remaining-session delta when immediate.
- I temporarily used `PORT_OFFSET=1500` because the required 900 was occupied; no other track's containers were stopped or changed.
