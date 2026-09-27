# QA Defects

## Open

### QA-OPS-001 — Render health probes have no `/readyz` handler and public status is missing

- **Owner:** Track C
- **Phase:** 16 §4.1 and §4.4
- **Evidence:** `render.yaml` sets `healthCheckPath: /readyz`, but no `/readyz` route is registered; the required public `/status` route is also absent.
- **Reproduce:** inspect the Render web service and search `server/src` for `/readyz` and a public `/status` handler; the health path is configuration-only and platform `/orgs/:orgId/status` is a separate authenticated mutation.
- **Expected:** `/readyz` reports readiness for the web service, and `/status` exposes only non-sensitive service state publicly.
- **Request:** implement/register both endpoints and add HTTP tests for ready/unready and public redaction behavior.
- **Status:** open launch blocker; configured production health checks currently target a missing route.

### QA-OPS-002 — Required key-generation npm scripts are missing

- **Owner:** Track C
- **Phase:** 16 §4.7
- **Evidence:** `scripts/keys-generate.ts` and `scripts/keys-vapid.ts` exist, but `package.json` defines neither `keys:generate` nor `keys:vapid`.
- **Reproduce:** inspect `package.json` scripts; both required commands are absent.
- **Expected:** operators can invoke `npm run keys:generate` and `npm run keys:vapid`, with safe owner-only output files and no key material in logs.
- **Request:** register the scripts and retain the existing file-permission protections.
- **Status:** open operator-tooling acceptance gap.

### QA-OPS-003 — Operational alert rules are not wired to a runtime check

- **Owner:** Track C
- **Phase:** 16 §4.3
- **Evidence:** `evaluateOperationalAlerts`, `captureOperationalAlert`, and `writeStructuredLog` are unused in production code; Knip reports the latter two as unused exports. Their unit tests do not schedule metric collection or deliver alerts.
- **Reproduce:** search non-test `server/src` for calls to those functions; only their definitions are present.
- **Expected:** periodic checks collect worker, queue, webhook, payment-failure, and email-bounce metrics and deliver redacted alerts through the configured sink.
- **Request:** wire the operational check/sink and structured logger in web and worker startup, with an integration test proving a synthetic alert reaches the fake sink.
- **Status:** open reliability acceptance gap.

### QA-OPS-004 — Web runtime receives `DATABASE_ADMIN_URL`

- **Owner:** Track C
- **Phase:** 16 §4.3
- **Evidence:** `render.yaml` supplies `DATABASE_ADMIN_URL` to the web service even though it is needed for pre-deploy migrations; OPS has an explicit request to remove it from web runtime after pre-deploy.
- **Reproduce:** inspect the `athlentry-web` environment variables in `render.yaml`.
- **Expected:** the privileged database URL is available to the pre-deploy migration command and absent from the running web process.
- **Request:** scope the admin URL to pre-deploy only and verify the web service starts without it.
- **Status:** open least-privilege deployment gap.

### QA-SEC-001 — Route permission and tenancy checks are not executable

- **Owner:** Track C
- **Phase:** 16 §1.2
- **Evidence:** `e2e/security/route-authorization.spec.ts:24`, `e2e/security/tenancy-fuzz.spec.ts:39`, and `e2e/security/permission-matrix.spec.ts:47` still declare `test.fixme`. `server/test/security/permission-matrix.json` has an empty `operations` object.
- **Reproduce:** inspect those three checks and the matrix; Playwright marks the checks as skipped before running their assertions.
- **Expected:** every generated API operation has permission/resource/scope metadata; every ID-bearing organization GET/PATCH/DELETE has a foreign-tenant fixture; every operation has a permission row whose allow/deny sets cover the role list exactly. The three checks run as tests and pass.
- **Request:** finish the generated route metadata and fixture contract, populate the matrix, and remove `test.fixme` only after the executable tests pass.
- **Status:** open; browser verification is also waiting on the required QA Postgres port.

### QA-SEC-002 — Security-header acceptance check is disabled

- **Owner:** Track C
- **Phase:** 16 §1.4
- **Evidence:** `e2e/security/security-headers.spec.ts:3` still declares `test.fixme`, while Track C reports the middleware is mounted in `server/src/app.ts`.
- **Reproduce:** inspect the test; Playwright skips its response-header assertions.
- **Expected:** the Chromium test checks CSP, HSTS production behavior, frame options, content-type, referrer, and permissions headers on the relevant response types and passes against the mounted middleware.
- **Request:** align the assertions with the mounted middleware and enable the test after it passes.
- **Status:** open; browser verification is also waiting on the required QA Postgres port.

### QA-SEC-003 — CI has no Gitleaks secret scan

- **Owner:** Track C
- **Phase:** 16 §1.3
- **Evidence:** no Gitleaks step or action is present in `.github/workflows/ci.yml` or `.github/`; Track C's wiring queue lists Gitleaks as unfinished.
- **Reproduce:** inspect `.github/workflows/ci.yml` and search `.github/` for `gitleaks`; no match is present.
- **Expected:** CI scans the repository with Gitleaks and fails on detected secrets without printing secret values.
- **Request:** add the scan to CI and verify the workflow on a clean repository state.
- **Status:** open.

### QA-SEC-004 — Web Push accepts internal network endpoints

- **Owner:** Track C
- **Phase:** 16 §1, SSRF protection
- **Evidence:** `server/src/integrations/push/sender.ts:78` forwards `subscription.endpoint` to the transport without destination validation; `e2e/security/ssrf.spec.ts:6` is `test.fixme` and uses a loopback metadata URL.
- **Reproduce:** instantiate `WebPushSender` with a fake transport and call `send` with `https://127.0.0.1:443/latest/meta-data`; the current code passes that endpoint to `sendNotification`.
- **Expected:** loopback, private, link-local, and non-provider destinations are rejected before transport, with DNS resolution protected from rebinding.
- **Request:** validate/pin permitted Web Push destinations and enable the regression test; keep the test synthetic and assert the transport is never called.
- **Status:** open security defect; no live request was made.

### QA-SEC-005 — Step-up reauthentication does not rotate the session

- **Owner:** Track A
- **Phase:** 16 §1.5
- **Evidence:** `e2e/security/session-step-up-fixation.spec.ts:10` is `test.fixme`; `stepUpWithPassword`/`stepUpWithTotp` elevate the existing session and the route does not issue a replacement cookie.
- **Reproduce:** inspect the step-up route and its regression; the required assertions for a new cookie token and revocation of the prior token are skipped.
- **Expected:** successful step-up rotates the session token, sends the replacement cookie with the required flags, and revokes the prior session token.
- **Request:** implement step-up session rotation and enable the regression after it passes.
- **Status:** open security defect; implementation is owned by Track A.

### QA-SEC-006 — CI has no SQL raw-interpolation guard

- **Owner:** Track C
- **Phase:** 16 §1.2
- **Evidence:** `.github/workflows/ci.yml` has no guard for interpolated `sql.raw` usage, although Phase 16 requires a CI check. No `sql.raw` call is currently present in `server/src` or `shared/src`.
- **Reproduce:** search the workflow and CI scripts for `sql.raw`; no check is defined.
- **Expected:** CI fails on `sql.raw` that incorporates interpolated or user-controlled input while allowing any explicitly reviewed static fragments.
- **Request:** add the source guard and a fixture test proving an unsafe interpolated use fails.
- **Status:** open security acceptance gap; no vulnerable `sql.raw` call was found in the current source.

### QA-ACC-002 — Guardian medical journey awaits browser verification

- **Owner:** Track A
- **Phase:** 2, required journey 2
- **Evidence:** upstream `2ac58d6` landed the medical flow and updated `e2e/guardian-invitation.spec.ts` to save allergy, medication and emergency-contact data. QA added saved-value assertions after reload and extended `e2e/security/guardian-idor.spec.ts` to assert that another guardian receives 404 for the medical profile.
- **Reproduce:** run `e2e/guardian-invitation.spec.ts` and `e2e/security/guardian-idor.spec.ts` against the isolated QA stack.
- **Expected:** accepted guardians can update and reload the child's medical data; an unlinked guardian cannot read it.
- **Request:** none; coverage is added on `track/qa`.
- **Status:** browser verification pending because Track I owns the QA Postgres port.

### QA-ACC-003 — Import acceptance does not exercise the required 2,000-row batch

- **Owner:** Track A
- **Phase:** 2, required journey 3
- **Evidence:** trunk `e2e/people-import.spec.ts` previews and rolls back a two-row file. QA added `e2e/journeys/import-scale.spec.ts` to exercise the specified 2,000-person batch and verify all rows are archived after rollback.
- **Reproduce:** run `e2e/journeys/import-scale.spec.ts` against the isolated QA stack.
- **Expected:** the full 2,000-row preview reports all records to create, commit succeeds, rollback marks all records archived, and axe reports no violations.
- **Request:** none; scale coverage is added on `track/qa`.
- **Status:** browser verification pending because Track I owns the QA Postgres port.

### QA-ACC-015 — Schedule generation-to-publication journey is missing

- **Owner:** Track G
- **Phase:** 8, required journey 15
- **Evidence:** schedule modules and console routes are on the current trunk, but no `e2e/` spec exercises generation review, apply, publication, and family notification as one flow.
- **Reproduce:** search `e2e/` for a schedule generator journey; `schedule-stats`, `schedule-rsvp`, and `schedule-offline` cover other paths only.
- **Expected:** a desktop and iPhone-width browser flow generates a schedule, reviews and applies it, publishes it, and verifies family notification delivery through the preview/Mailpit adapter, with axe checks.
- **Request:** add the missing Phase 8 browser journey and run it against the isolated QA stack.
- **Status:** open coverage gap; no product defect established.

### QA-ACC-016 — Rainout journey omits notification and reschedule approval

- **Owner:** Track G
- **Phase:** 8, required journey 16
- **Evidence:** `e2e/schedule-stats.spec.ts` closes a facility and checks that an affected event is postponed; it does not assert notification delivery or an approved reschedule request.
- **Reproduce:** run the schedule statistics journey and inspect the closure flow; it ends after the event status changes.
- **Expected:** affected families receive the preview/Mailpit notice, a reschedule request is submitted, and staff approves it through the browser flow.
- **Request:** extend or add the rainout acceptance journey through notice delivery and approved rescheduling, with axe checks.
- **Status:** open coverage gap; no product defect established.

### QA-ACC-017 — Offline game-day journey omits lineup warning and successful score sync

- **Owner:** Track G
- **Phase:** 9, required journey 17
- **Evidence:** `e2e/schedule-offline.spec.ts` verifies offline attendance sync and preserves a conflicting score in the queue; it does not exercise a lineup minimum-play warning or a successful score sync.
- **Reproduce:** run the offline game-day journey; it deliberately creates a version conflict before score synchronization and never opens a lineup.
- **Expected:** the coach sees and resolves the lineup warning, enters attendance and score offline, reconnects, and verifies both accepted changes synchronize (with a separate conflict assertion if needed).
- **Request:** extend or add the required browser flow with lineup warning and successful offline score synchronization, with axe checks.
- **Status:** open coverage gap; no product defect established.

### QA-ACC-018 — Double-elimination external-team journey is missing

- **Owner:** Track G
- **Phase:** 9, required journey 18
- **Evidence:** `server/src/modules/tournaments/bracket-acceptance.test.ts` tests bracket logic, but no Playwright spec covers external-team entry and tournament progression.
- **Reproduce:** search `e2e/` for a tournament journey; none is present.
- **Expected:** a desktop browser flow enters external teams, runs the double-elimination bracket through the final, and verifies the winner, with axe checks.
- **Request:** add the missing desktop Playwright acceptance journey.
- **Status:** open coverage gap; no product defect established.

### QA-ACC-019 — Swim-meet results and team-scoring browser journey is missing

- **Owner:** Track G
- **Phase:** 9, required journey 19
- **Evidence:** `server/src/modules/contests/meet.integration.test.ts` covers meet results and team scoring at the service layer; no browser acceptance flow exists.
- **Reproduce:** search `e2e/` for a swim meet result journey; none is present.
- **Expected:** a desktop browser flow enters timed results and verifies team scoring with axe checks.
- **Request:** add the missing desktop Playwright acceptance journey.
- **Status:** open coverage gap; no product defect established.

### QA-ACC-020 — Officials assignment and pay-batch browser journey is missing

- **Owner:** Track G
- **Phase:** 9, required journey 20
- **Evidence:** `server/src/modules/officials/service.integration.test.ts` covers assignment/pay behavior at the service layer; no browser journey exercises the official and staff workflow.
- **Reproduce:** search `e2e/` for an officials assignment journey; none is present.
- **Expected:** staff assigns officials, an official declines, staff reassigns, and a pay batch is created and verified in the browser with axe checks.
- **Request:** add the missing Phase 9 Playwright acceptance journey.
- **Status:** open coverage gap; no product defect established.

### QA-ACC-021 — Communications journey omits quiet-hour deferral and unsubscribe

- **Owner:** Track H
- **Phase:** 10, required journey 21
- **Evidence:** `e2e/communications.spec.ts` covers bilingual composition, test-send and schedule cancellation. It does not assert quiet-hour delivery deferral or complete tokenized unsubscribe in a browser. H reports service-level integration coverage for quiet hours and unsubscribe.
- **Reproduce:** run the campaign journey and inspect its flow; it cancels the schedule without sending a campaign to a recipient during quiet hours or following the unsubscribe link.
- **Expected:** a campaign to a opted-in recipient is deferred until quiet hours end; the recipient follows the signed unsubscribe link, sees the confirmation page, and the category preference becomes disabled.
- **Request:** extend/add the Phase 10 browser journey for both quiet-hour deferral and tokenized unsubscribe using preview/Mailpit adapters.
- **Status:** open coverage gap; no service defect is established by the current tests.


### QA-ACC-024 — Academy browser journey omits tuition proration and level promotion

- **Owner:** Track I
- **Phase:** 12, required journey 24
- **Evidence:** `e2e/classes.spec.ts` covers absence, make-up credit issuance, family booking, and staff attendance; it does not exercise monthly tuition/proration or a level promotion.
- **Reproduce:** run the classes journey and inspect its steps; it finishes after attendance is saved for the make-up session.
- **Expected:** the browser flow exercises monthly tuition with proration, make-up booking, and a level promotion, then verifies the resulting enrollment/tuition state and axe checks.
- **Request:** extend or add the academy Playwright journey to cover the missing billing and promotion acceptance paths.
- **Status:** open coverage gap; no product defect established.

### QA-PERF-001 — App bundle exceeds the enforced gzip budget

- **Owner:** Track C
- **Phase:** 16 §2.5
- **Evidence:** `npm run build` succeeds, but the configured `package.json` size limit is 200 KB gzipped and the built `dist/web/assets/app-*.js` measures 395.62 KB gzipped.
- **Reproduce:** run `npm run build && npm run size`; size-limit exits 1 with “Package size limit has exceeded by 195.62 kB”.
- **Expected:** the production entry bundle meets the configured 200 KB gzip budget through appropriate code splitting and deferred feature imports.
- **Request:** reduce the entry bundle to the enforced budget and add `npm run size` to the final launch gate.
- **Status:** open; `npm run build` itself is green, but the separate bundle-budget check fails.

### QA-QUAL-001 — Knip launch gate fails on unused files and exports

- **Owner:** Tracks A, C, G, and I; Track C owns the launch gate.
- **Phase:** 16 §1.3
- **Evidence:** `npm run knip` exits 1 with 6 unused files, 43 unused exports, 28 unused exported types, and 1 duplicate export across A/C/G/I-owned code.
- **Reproduce:** run `npm run knip`; the output names the unused exports and `eventSeriesCreateSchema|eventSeriesSchema` duplicate.
- **Expected:** `npm run knip` exits 0 after owners remove dead exports/files or wire intended public contracts into their generated registries.
- **Request:** clear the findings listed in `docs/codex/tracks/SEC.md` and make the required Knip gate green. QA removed its own unused `OrganizationRole` crawler type; no other QA-owned Knip finding remains.
- **Status:** open cross-track quality gate.

### QA-ACC-030 — Manual keyboard-only acceptance script is missing

- **Owner:** Track D
- **Phase:** 16 §3.1
- **Evidence:** `docs/qa/ACCESSIBILITY.md` is absent; no accessibility manual-pass script is present under `docs/`.
- **Reproduce:** search the docs tree for an accessibility keyboard-only pass script; no match exists.
- **Expected:** `docs/qa/ACCESSIBILITY.md` documents keyboard-only checks across all journeys in `30 §3` (currently 27 entries; Phase 16 §3.1 says 25), including dialogs, menus, calendar/drag alternatives, and focus behavior.
- **Request:** add the manual accessibility pass script and record its completion evidence.
- **Status:** open accessibility acceptance gap.

### QA-ACC-031 — CI has no English-to-Spanish completeness check

- **Owner:** Track D
- **Phase:** 16 §3.3
- **Evidence:** no locale/i18n/translation completeness script or workflow check is present under `scripts/` or `.github/`. The three current English/Spanish JSON pairs (`auth`, `platform`, and `portal`) have matching keys, but no automated gate checks them and `site`/`email` namespaces are not present.
- **Reproduce:** search `scripts/` and `.github/` for locale, i18n, translation, or Spanish completeness checks; no match exists.
- **Expected:** CI fails when any English key in the portal, site, auth, or email namespaces has no Spanish value.
- **Request:** add the completeness checker, a missing-key regression fixture, and the CI step.
- **Status:** open internationalization acceptance gap.

### QA-ACC-032 — Accessibility statements are absent from public site surfaces

- **Owner:** Track D
- **Phase:** 16 §3.4
- **Evidence:** no accessibility statement page or footer link exists in `web/src` or `server/src`; the public marketing/org-site surfaces are also not present on the current trunk snapshot.
- **Reproduce:** search the source tree for an accessibility statement page or link; no match exists.
- **Expected:** a public accessibility statement is linked from the marketing site and each organization-site footer when those surfaces land.
- **Request:** include the statement page and footer links in the public-site integration, then add browser coverage.
- **Status:** open launch acceptance dependency; no current public-site route is available to test.
