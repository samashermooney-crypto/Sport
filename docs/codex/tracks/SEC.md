# Track SEC — Phase 16 §1 security

Status: working
Branch: `track/sec`
Current: synced `rebuild/trunk` through `9b934b0`. The earlier SEC control set is already on trunk; this pass is closing stale verification gaps and extending the browser security checks.

## Ready for integration ranges

- SEC commits `a4eabf0` and `22109ee` — guardian IDOR and CSRF regressions, security header activation, SSRF and step-up regression requests, and security documentation refresh. Branch is synced through `9b934b0`; integration gate remains pending.

## Requests to other tracks

- C — SEC-002: add generated `permission`, `resource`, and scope metadata for every API operation, then publish it in OpenAPI and the route registry. For every ID-bearing organization-scoped GET/PATCH/DELETE, publish a fixture with an existing synthetic foreign-organization resource ID for each resource path parameter and a schema-valid body for mutations. Populate `server/test/security/permission-matrix.json` with reviewed allow/deny roles for every operation. Keep `route-authorization`, `tenancy-fuzz`, and `permission-matrix` checks blocked until these contracts are generated; the current OpenAPI has no `x-athlentry-*` metadata and the matrix is empty.
- C — SEC-SSRF-C-001: validate user-controlled Web Push subscription destinations before calling `web-push`. `WebPushSender.send` currently forwards an account-supplied HTTPS endpoint such as `https://127.0.0.1/...` directly to its HTTP client. Reject loopback, private, link-local, and non-provider hosts before transport, with DNS rebinding/address pinning protection; the regression assertion is `test.fixme` in `e2e/security/ssrf.spec.ts`.
- C — SEC-CI-001: add Gitleaks secret scanning to CI for pull requests and protected-branch pushes. CI currently has no Gitleaks job.
- A — SEC-005: rotate the current session identifier and cookie after successful `/api/v1/auth/step-up`, and revoke the prior token. `stepUpWithPassword`/`stepUpWithTotp` currently update `elevated_until` on the existing session, and the route sends no replacement cookie despite Phase 16 §1 requiring session rotation on step-up. `e2e/security/session-step-up-fixation.spec.ts` is committed as `test.fixme` until A's auth route change lands.
- A — SEC-KNIP-A: triage the current Knip findings in A-owned shared schemas: unused `importRowPreviewSchema` and `ImportRowPreview`/`ImportBatchList`/`ImportMappingPreset` in `shared/src/schemas/imports.ts`, plus `duplicatePersonSchema`, `duplicatePairSchema`, and `personMergeSummarySchema` in `shared/src/schemas/people.ts`.
- G — SEC-KNIP-G: triage Knip findings in G-owned schedule/officials files: unused `web/src/console/schedule/nav.ts` and `web/src/portal/schedule/nav.ts`; exports `testComplianceForOfficial`, `generatorInputFromConstraints`, `scheduleGenerationJob`, `scheduleSeriesHorizonJob`, `scheduleBatchEmitJob`, `runScheduleGeneration`, `extendRecurringSeries`, `routeError`, `eventKindSchema`, `eventStatusSchema`, `participantInputSchema`, `eventCreateSchema`, `eventIdResponseSchema`, `conflictReportSchema`, `eventSeriesSchema`, `importScheduleFile`, `importScheduleCsv`, and `escapeHtml`; types `EventCreateInput`, `EventSeriesCreateInput`, `SeriesEditInput`, `SpaceAvailabilityCreateInput`, `SpaceBlackoutCreateInput`, and `BlackoutRequestInput`; duplicate `eventSeriesCreateSchema|eventSeriesSchema` export.

## Blocked on

- Every-route permission and tenancy completeness are blocked on SEC-002's generated route metadata, real foreign-resource fixtures, and reviewed role matrix from Track C.
- SSRF coverage is incomplete until Track C closes SEC-SSRF-C-001; the configured push sender currently forwards user-controlled endpoints to the network client.
- CI secret scanning is blocked on SEC-CI-001 from Track C.
- Step-up session rotation is blocked on SEC-005 from Track A; the route currently elevates the same session without issuing a fresh cookie.
- The Phase 16 Knip-clean requirement is blocked on SEC-KNIP-A and SEC-KNIP-G; `npm run knip` reports A/G-owned unused exports/files on the current trunk snapshot.

## Verification

- Affected security Vitest selection: 16 files, 66 tests passed, including missing-header/missing-origin CSRF, production security.txt, rate limits, webhook signatures, upload bypass, stored XSS, session fixation, MFA/impersonation, key rotation, headers, and platform-staff authorization.
- Full Vitest suite with a four-worker cap: 239 files and 842 tests passed; 1 existing skipped file/test. The initial default-worker run timed out broadly under database contention; limiting concurrency kept every test enabled and completed green.
- Platform-staff MFA/authorization regression: `server/src/modules/platform/routes.test.ts` — 2 passed.
- Targeted Chromium security specs: 2 passed (global response headers and guardian direct-medical IDOR); 5 skipped with `test.fixme` for the documented Track C and Track A dependencies.
- `npm run typecheck`, `npm run lint`, targeted Prettier checks, and `git diff --check` pass on the latest `9b934b0` trunk sync.
- `npm run build` passes on the latest `9b934b0` trunk sync. `npm audit --omit=dev --audit-level=high` exits clean for high/critical findings; npm reports two moderate transitive `uuid` advisories beneath `exceljs`.
- `npm run knip` fails on 2 unused G schedule nav files, 22 unused exports, 9 unused types, and 1 duplicate export; detailed owner requests are above.
- Existing rate-limit, webhook-signature, upload bypass, SSRF, stored-XSS, session fixation, MFA/impersonation, and key-rotation checks are included in the 66 passing tests. Step-up token rotation remains `test.fixme` against the observed Track A gap.
