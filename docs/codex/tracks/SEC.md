# Track SEC — Phase 16 §1 security

Status: working
Branch: `track/sec`
Current: final follow-up commit `c1a5a90` passed the shared-trunk merge gate against `rebuild/trunk` at `7175207`; its changes are integrated by this merge.

## Ready for integration ranges

- Integrated SEC commits `a4eabf0` and `22109ee` passed the shared-trunk gate. Follow-up commit `c1a5a90` adds the Gitleaks CI regression marker and current C/I Knip requests; it passed the shared-trunk merge gate and is integrated by this merge.

## Requests to other tracks

- C — SEC-002: add generated `permission`, `resource`, and scope metadata for every API operation, then publish it in OpenAPI and the route registry. For every ID-bearing organization-scoped GET/PATCH/DELETE, publish a fixture with an existing synthetic foreign-organization resource ID for each resource path parameter and a schema-valid body for mutations. Populate `server/test/security/permission-matrix.json` with reviewed allow/deny roles for every operation. Keep `route-authorization`, `tenancy-fuzz`, and `permission-matrix` checks blocked until these contracts are generated; the current OpenAPI has no `x-athlentry-*` metadata and the matrix is empty.
- C — SEC-SSRF-C-001: **implemented** — `WebPushSender` restricts destinations to supported push providers over HTTPS/443, rejects any non-public DNS answer and pins the HTTPS agent to the validated address. Sender tests cover private and transition ranges, mixed DNS answers and rebinding; the enabled Chromium SSRF regression passes.
- C — SEC-CI-001: **implemented** — CI runs Gitleaks v3 on pull requests and configured pushes with full history and Gitleaks 8.29.1 pinned. The enabled Playwright source assertion checks the workflow; hosted CI status remains unobserved locally. Organization-owned repositories need the `GITLEAKS_LICENSE` secret.
- A — SEC-005: **implemented** — password/TOTP step-up now atomically revokes and rotates the active session, returning a replacement cookie or a no-store bearer token; MFA enrollment confirmation and step-up consume the MFA rate limit. Auth security/routes tests and the enabled Chromium fixation regression pass.
- A — SEC-KNIP-A: triage the current Knip findings in A-owned shared schemas: unused `importRowPreviewSchema` and `ImportRowPreview`/`ImportBatchList`/`ImportMappingPreset` in `shared/src/schemas/imports.ts`, plus `duplicatePersonSchema`, `duplicatePairSchema`, and `personMergeSummarySchema` in `shared/src/schemas/people.ts`.
- C — SEC-KNIP-C: triage Knip findings in C-owned files: unused `scripts/backup.ts` and `scripts/restore-drill.ts`; exports `writeStructuredLog` from `server/src/lib/observability/logging.ts` and `captureOperationalAlert`/`captureRedactedException` from `server/src/lib/observability/sentry.ts`.
- I — SEC-KNIP-I: triage Knip findings in I-owned class paths: unused `web/src/console/classes/nav.ts` and `web/src/portal/classes/nav.ts`; exports `requireSessionInstructor`, `ageMonths`, `nextMonthBillingDate`, `stripExceptions`, `materializeScheduleSessions`, `deterministicUuid`, `mandateHashFor`, `billSubscription`; shared schemas `classBillingSchema`, `tuitionTiersSchema`, `makeupPolicySchema`, `instructorSchema`, `enrollmentStatusSchema`, `waitlistEntrySchema`, `sessionAttendanceSchema`, `skillRecordStatusSchema`, `athleteSkillRecordSchema`, `classesErrorCodes`; types `ClassBilling`, `MakeupPolicy`, `WaitlistEntry`, `AttendanceMark`, `SessionAttendance`, `CheckOutBody`, `BookMakeupBody`, `PunchCardPurchase`, `DropInBody`, `SubscriptionUpdate`, `SyncLevelsBody`, `SkillRecordStatus`, `AthleteSkillRecord`, `RecordSkillBody`, `SessionSkillMarks`, `RecommendPromotion`, `PromotionDecision`, `WithdrawResult`, and `ResumeBody`.
- G — SEC-KNIP-G: triage Knip findings in G-owned schedule/officials files: unused `web/src/console/schedule/nav.ts` and `web/src/portal/schedule/nav.ts`; exports `testComplianceForOfficial`, `generatorInputFromConstraints`, `scheduleGenerationJob`, `scheduleSeriesHorizonJob`, `scheduleBatchEmitJob`, `runScheduleGeneration`, `extendRecurringSeries`, `routeError`, `eventKindSchema`, `eventStatusSchema`, `participantInputSchema`, `eventCreateSchema`, `eventIdResponseSchema`, `conflictReportSchema`, `eventSeriesSchema`, `importScheduleFile`, `importScheduleCsv`, and `escapeHtml`; types `EventCreateInput`, `EventSeriesCreateInput`, `SeriesEditInput`, `SpaceAvailabilityCreateInput`, `SpaceBlackoutCreateInput`, and `BlackoutRequestInput`; duplicate `eventSeriesCreateSchema|eventSeriesSchema` export.

## Blocked on

- Every-route permission and tenancy completeness are blocked on SEC-002's generated route metadata, real foreign-resource fixtures, and reviewed role matrix from Track C.
- Every-route permission and tenancy completeness still require Track C's reviewed SEC-002 metadata, real foreign-resource fixtures, and role matrix.
- The hosted Gitleaks job result has not been observed from this local environment; an organization repository must configure `GITLEAKS_LICENSE`.
- The final Knip-clean gate is blocked on SEC-KNIP-A/C/G/I; the current trunk reports 6 unused files, 43 unused exports, 28 unused types, and one duplicate export.

## Verification

- Affected security Vitest selection: 16 files, 66 tests passed, including missing-header/missing-origin CSRF, production security.txt, rate limits, webhook signatures, upload bypass, stored XSS, session fixation, MFA/impersonation, key rotation, headers, and platform-staff authorization.
- Full Vitest suite with a four-worker cap: 239 files and 842 tests passed; 1 existing skipped file/test. The initial default-worker run timed out broadly under database contention; limiting concurrency kept every test enabled and completed green.
- Platform-staff MFA/authorization regression: `server/src/modules/platform/routes.test.ts` — 2 passed.
- Earlier targeted Chromium snapshot: 2 passed (global response headers and guardian direct-medical IDOR), with 6 security `test.fixme` cases. On the current branch, the newly enabled Gitleaks, SSRF, and fixation journeys pass 3/3; the three SEC-002 route/matrix/tenancy cases remain blocked under DEC-114.
- Push sender tests pass 11/11; auth security and route integration tests pass, including bearer/cookie rotation, original absolute-expiry preservation, and MFA step-up rate limiting.
- `npm run typecheck`, `npm run lint`, targeted Prettier checks, and `git diff --check` pass on the latest `7175207` trunk sync.
- Shared-trunk merge gate: typecheck and lint passed; full Vitest passed with 239 files / 842 tests passing and one existing skipped file/test; Chromium desktop passed 32 tests with the six documented cross-track `test.fixme` cases.
- `npm run build` passes on the latest `7175207` trunk sync. `npm audit --omit=dev --audit-level=high` exits clean for high/critical findings; npm reports two moderate transitive `uuid` advisories beneath `exceljs`.
- `npm run knip` fails on the current trunk with 6 unused files, 43 unused exports, 28 unused types, and 1 duplicate export; owner requests are above.
## Requests from QA

- QA-SEC-018: rotate omitted `athlete_cards.qr_secret_enc` and `checkouts.requirements_enc`, plus split-envelope `fundraising_settings.ein_ciphertext` (key ID is stored in `ein_key_version`). These values are written through `encryptRestricted()` but absent from `server/src/lib/security/encryption-rotation.ts`; the existing CLI test covers only medical profiles and MFA. Add dry-run/apply assertions and a completeness guard. See `docs/codex/qa/DEFECTS.md`.
- Existing rate-limit, webhook-signature, upload bypass, SSRF, stored-XSS, session fixation, MFA/impersonation, and key-rotation checks are included in the 66 passing tests. Step-up token rotation remains `test.fixme` against the observed Track A gap.

- Existing CSRF, rate-limit, webhook-signature, upload bypass, SSRF, stored-XSS, MFA/impersonation, and key-rotation checks are included in the passing security suite. Step-up token rotation is verified by the enabled targeted auth and Chromium regressions above.
