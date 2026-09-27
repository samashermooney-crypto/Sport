# Track SEC — Phase 16 §1 security

Status: working
Branch: `track/sec`
Current: follow-up work is based on `rebuild/trunk` at `7175207`; the prior SEC change is integrated and this follow-up adds the Gitleaks regression marker and current Knip owner requests.

## Ready for integration ranges

- Integrated SEC commits `a4eabf0` and `22109ee` passed the shared-trunk gate. Follow-up on `7175207`: Gitleaks CI regression marker plus current C/I Knip requests; follow-up merge gate pending.

## Requests to other tracks

- C — SEC-002: add generated `permission`, `resource`, and scope metadata for every API operation, then publish it in OpenAPI and the route registry. For every ID-bearing organization-scoped GET/PATCH/DELETE, publish a fixture with an existing synthetic foreign-organization resource ID for each resource path parameter and a schema-valid body for mutations. Populate `server/test/security/permission-matrix.json` with reviewed allow/deny roles for every operation. Keep `route-authorization`, `tenancy-fuzz`, and `permission-matrix` checks blocked until these contracts are generated; the current OpenAPI has no `x-athlentry-*` metadata and the matrix is empty.
- C — SEC-SSRF-C-001: validate user-controlled Web Push subscription destinations before calling `web-push`. `WebPushSender.send` currently forwards an account-supplied HTTPS endpoint such as `https://127.0.0.1/...` directly to its HTTP client. Reject loopback, private, link-local, and non-provider hosts before transport, with DNS rebinding/address pinning protection; the regression assertion is `test.fixme` in `e2e/security/ssrf.spec.ts`.
- C — SEC-CI-001: add Gitleaks secret scanning to CI for pull requests and protected-branch pushes. CI currently has no Gitleaks job; `e2e/security/gitleaks-ci.spec.ts` is committed as `test.fixme` until the workflow job lands.
- A — SEC-005: rotate the current session identifier and cookie after successful `/api/v1/auth/step-up`, and revoke the prior token. `stepUpWithPassword`/`stepUpWithTotp` currently update `elevated_until` on the existing session, and the route sends no replacement cookie despite Phase 16 §1 requiring session rotation on step-up. `e2e/security/session-step-up-fixation.spec.ts` is committed as `test.fixme` until A's auth route change lands.
- A — SEC-KNIP-A: triage the current Knip findings in A-owned shared schemas: unused `importRowPreviewSchema` and `ImportRowPreview`/`ImportBatchList`/`ImportMappingPreset` in `shared/src/schemas/imports.ts`, plus `duplicatePersonSchema`, `duplicatePairSchema`, and `personMergeSummarySchema` in `shared/src/schemas/people.ts`.
- C — SEC-KNIP-C: triage Knip findings in C-owned files: unused `scripts/backup.ts` and `scripts/restore-drill.ts`; exports `writeStructuredLog` from `server/src/lib/observability/logging.ts` and `captureOperationalAlert`/`captureRedactedException` from `server/src/lib/observability/sentry.ts`.
- I — SEC-KNIP-I: triage Knip findings in I-owned class paths: unused `web/src/console/classes/nav.ts` and `web/src/portal/classes/nav.ts`; exports `requireSessionInstructor`, `ageMonths`, `nextMonthBillingDate`, `stripExceptions`, `materializeScheduleSessions`, `deterministicUuid`, `mandateHashFor`, `billSubscription`; shared schemas `classBillingSchema`, `tuitionTiersSchema`, `makeupPolicySchema`, `instructorSchema`, `enrollmentStatusSchema`, `waitlistEntrySchema`, `sessionAttendanceSchema`, `skillRecordStatusSchema`, `athleteSkillRecordSchema`, `classesErrorCodes`; types `ClassBilling`, `MakeupPolicy`, `WaitlistEntry`, `AttendanceMark`, `SessionAttendance`, `CheckOutBody`, `BookMakeupBody`, `PunchCardPurchase`, `DropInBody`, `SubscriptionUpdate`, `SyncLevelsBody`, `SkillRecordStatus`, `AthleteSkillRecord`, `RecordSkillBody`, `SessionSkillMarks`, `RecommendPromotion`, `PromotionDecision`, `WithdrawResult`, and `ResumeBody`.
- G — SEC-KNIP-G: triage Knip findings in G-owned schedule/officials files: unused `web/src/console/schedule/nav.ts` and `web/src/portal/schedule/nav.ts`; exports `testComplianceForOfficial`, `generatorInputFromConstraints`, `scheduleGenerationJob`, `scheduleSeriesHorizonJob`, `scheduleBatchEmitJob`, `runScheduleGeneration`, `extendRecurringSeries`, `routeError`, `eventKindSchema`, `eventStatusSchema`, `participantInputSchema`, `eventCreateSchema`, `eventIdResponseSchema`, `conflictReportSchema`, `eventSeriesSchema`, `importScheduleFile`, `importScheduleCsv`, and `escapeHtml`; types `EventCreateInput`, `EventSeriesCreateInput`, `SeriesEditInput`, `SpaceAvailabilityCreateInput`, `SpaceBlackoutCreateInput`, and `BlackoutRequestInput`; duplicate `eventSeriesCreateSchema|eventSeriesSchema` export.

## Blocked on

- Every-route permission and tenancy completeness are blocked on SEC-002's generated route metadata, real foreign-resource fixtures, and reviewed role matrix from Track C.
- SSRF coverage is incomplete until Track C closes SEC-SSRF-C-001; the configured push sender currently forwards user-controlled endpoints to the network client.
- CI secret scanning is blocked on SEC-CI-001 from Track C.
- Step-up session rotation is blocked on SEC-005 from Track A; the route currently elevates the same session without issuing a fresh cookie.
- The final Knip-clean gate is blocked on SEC-KNIP-A/C/G/I; the current trunk reports 6 unused files, 43 unused exports, 28 unused types, and one duplicate export.

## Verification

- Affected security Vitest selection: 16 files, 66 tests passed, including missing-header/missing-origin CSRF, production security.txt, rate limits, webhook signatures, upload bypass, stored XSS, session fixation, MFA/impersonation, key rotation, headers, and platform-staff authorization.
- Full Vitest suite with a four-worker cap: 239 files and 842 tests passed; 1 existing skipped file/test. The initial default-worker run timed out broadly under database contention; limiting concurrency kept every test enabled and completed green.
- Platform-staff MFA/authorization regression: `server/src/modules/platform/routes.test.ts` — 2 passed.
- Targeted Chromium security specs: 2 passed (global response headers and guardian direct-medical IDOR); The Gitleaks CI guard is covered by a focused `test.fixme` run (1 expected skip); the full security suite is being rerun with it included.
- `npm run typecheck`, `npm run lint`, targeted Prettier checks, and `git diff --check` pass on the latest `7175207` trunk sync.
- Shared-trunk merge gate: typecheck and lint passed; full Vitest passed with 239 files / 842 tests passing and one existing skipped file/test; Chromium desktop passed 32 tests with the five documented cross-track `test.fixme` cases.
- `npm run build` passes on the latest `7175207` trunk sync. `npm audit --omit=dev --audit-level=high` exits clean for high/critical findings; npm reports two moderate transitive `uuid` advisories beneath `exceljs`.
- `npm run knip` fails on the current trunk with 6 unused files, 43 unused exports, 28 unused types, and 1 duplicate export; owner requests are above.
- Existing rate-limit, webhook-signature, upload bypass, SSRF, stored-XSS, session fixation, MFA/impersonation, and key-rotation checks are included in the 66 passing tests. Step-up token rotation remains `test.fixme` against the observed Track A gap.
