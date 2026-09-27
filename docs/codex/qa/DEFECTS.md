# QA Defects

## Open

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

### QA-ACC-002 — Guardian invitation journey stops before medical editing

- **Owner:** Track A
- **Phase:** 2, required journey 2
- **Evidence:** `e2e/guardian-invitation.spec.ts` verifies invitation acceptance and family visibility, but does not edit the child's medical information. `docs/codex/PROGRESS.md` says medical editing remains open.
- **Reproduce:** run the guardian invitation journey and inspect the assertions after `/me/family`; there is no medical edit step.
- **Expected:** after accepting the verified invite, the guardian opens the child's medical form, saves an authorized update, and sees the saved value on reload; unauthorized access remains denied.
- **Request:** add the medical-editing acceptance step when the Phase 2 medical flow lands. This is a coverage gap, not a known product defect.
- **Status:** open coverage gap; implementation is not yet on the audit snapshot.

### QA-ACC-021 — Communications journey omits quiet-hour deferral and unsubscribe

- **Owner:** Track H
- **Phase:** 10, required journey 21
- **Evidence:** `e2e/communications.spec.ts` covers bilingual composition, test-send and schedule cancellation. It does not assert quiet-hour delivery deferral or complete tokenized unsubscribe in a browser. H reports service-level integration coverage for quiet hours and unsubscribe.
- **Reproduce:** run the campaign journey and inspect its flow; it cancels the schedule without sending a campaign to a recipient during quiet hours or following the unsubscribe link.
- **Expected:** a campaign to a opted-in recipient is deferred until quiet hours end; the recipient follows the signed unsubscribe link, sees the confirmation page, and the category preference becomes disabled.
- **Request:** extend/add the Phase 10 browser journey for both quiet-hour deferral and tokenized unsubscribe using preview/Mailpit adapters.
- **Status:** open coverage gap; no service defect is established by the current tests.
