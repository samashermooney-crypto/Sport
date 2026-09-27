# Track QA — acceptance audit

Status: working
Branch: `track/qa`

## Ready for integration ranges

- None yet. The five original QA commits and follow-up audits remain unmerged. Latest sync merge `74e8a30` includes `rebuild/trunk` `0ca39573`. Typecheck and lint pass, 15 isolated security unit tests pass, and Playwright lists 24 Chromium tests across seven QA specs. Full PostgreSQL and browser execution remain blocked while Track I owns the prescribed QA offset 1500.

## Requests to other tracks

- C — QA-OPS-001–004: implement `/readyz` and public `/status`, register key-generation scripts, wire periodic operational alerts/logging, and remove `DATABASE_ADMIN_URL` from the web runtime after pre-deploy. Details and reproductions are in `docs/codex/qa/DEFECTS.md`.
- C — QA-ACC-033: expose the Federation route in normal permission-gated console navigation; the current Phase 13 Playwright flow reaches it only by manually entering its URL. Details are in `docs/codex/qa/DEFECTS.md`.
- J — QA-ACC-034 and QA-SEC-007: add real-Postgres assertions that ending a relationship immediately denies prior cross-org reads and that an unrelated third org cannot read/write the two explicit federation RLS tables. Details are in `docs/codex/qa/DEFECTS.md`.
- J — QA-ACC-035: align the federation migration's data-sharing trigger keys with the schema/service's persisted snake_case keys; accepting `team_entries` or `compliance_status` appears to fail the trigger. Add a real-Postgres regression. Runtime verification is blocked by the QA port collision; see `docs/codex/qa/DEFECTS.md`.
- J — QA-ACC-036: extend journey 25 so its generated schedule proves both member-club field windows influence the result; its current one-game, one-round assertion cannot detect an ignored contribution. Details are in `docs/codex/qa/DEFECTS.md`.
- J — QA-SEC-008: add a real-Postgres regression for `readMemberCompliance` proving the shared response contains status-only fields, denied sharing yields no data, and successful reads are audited in both organizations. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-001: publish permission/resource/scope metadata and tenancy fixture contracts for every API operation; the route-authorization, permission-matrix, and tenancy-fuzz e2e checks still use `test.fixme`, and the permission matrix has no operation rows. Details and reproduction are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-002: enable the security-header browser check; it remains `test.fixme` even though C reports the middleware is mounted. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-003: add Gitleaks to CI; the current workflow has no secret scan. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-004: validate Web Push subscription destinations before the transport call; loopback and internal destinations currently reach `sendNotification`, and the SSRF regression is `test.fixme`. Details are in `docs/codex/qa/DEFECTS.md`.
- A — QA-SEC-005: rotate the session and cookie after successful step-up and revoke the old token; the regression is `test.fixme`. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-006: add the Phase 16 CI guard against interpolated `sql.raw`; no unsafe call exists now, but no guard is configured. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-PERF-001: reduce the gzipped app bundle to the configured 200 KB budget; current `npm run size` measures 404.93 KB and exits 1. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-QUAL-001: coordinate required Knip cleanup across A/C/G/I/J and the pending K demo contract; post-Phase 13 `npm run knip` exits 1 with 8 unused files, 44 exports, 28 exported types, and 1 duplicate. Details are in `docs/codex/qa/DEFECTS.md`.
- D — QA-ACC-030–031: add the manual keyboard-only script for the required journeys and the English-to-Spanish completeness gate in CI. Neither artifact/check exists in the current tree; details are in `docs/codex/qa/DEFECTS.md`.
- D — QA-ACC-032: add an accessibility statement and footer links to the marketing and organization-site surfaces when they land; no public-site surfaces are on the current trunk snapshot.
- G — QA-ACC-015–020: add the missing Phase 8/9 browser flows and complete the partial rainout and offline game-day flows; details and exact gaps are in `docs/codex/qa/DEFECTS.md`.
- H — QA-ACC-021: extend the communications browser journey through quiet-hour deferral and tokenized unsubscribe. Details are in `docs/codex/qa/DEFECTS.md`.
- H — QA-ACC-037: run the Phase 11 $300 donation acceptance flow from an anonymous browser context; its current scenario retains the authenticated setup session. Details are in `docs/codex/qa/DEFECTS.md`.
- H — QA-SEC-009: restrict household volunteer ledger reads to a verified guardian of that household or an authorized volunteer oversight role; the current service grants any active organization membership access. A scoped-director regression is marked `test.fixme` in `e2e/security/volunteer-household-ledger.spec.ts`.
- H/E — QA-ACC-038: link family uniform orders to the selected athlete's registration/team and reject forged team attribution so paid purchases feed accurate size reports. The portal-to-report regression is marked `test.fixme` in `e2e/phase11-uniform-report.spec.ts`.
- H — QA-ACC-039: make volunteer buyout unit reservation and invoice issuance concurrency-safe; a late conflicting request currently leaves an invoice behind. Regression is marked `test.fixme` in `e2e/phase11-buyout-race.spec.ts`.
- I — QA-ACC-024: extend the academy browser flow to cover monthly tuition/proration and level promotion in addition to its current make-up booking and attendance coverage. Details are in `docs/codex/qa/DEFECTS.md`.
- I — release or move the active `athlentry_i` stack from the QA-required `PORT_OFFSET=1500`; its Postgres, Mailpit, and Stripe mock mappings collide with ports `6932`, `2525/9525`, and `13611`. Do not stop the other track's containers from QA.

## Blocked on

- PostgreSQL-backed Vitest and Chromium/WebKit QA runs need the services on `PORT_OFFSET=1500`; Track I currently owns Postgres `6932`, Mailpit SMTP/API `2525/9525`, and Stripe mock `13611`. The Playwright web server exits before collection with code 1 because of this collision. The full unit/integration gate was not run because the isolated QA database could not start; do not point tests at Track I's database or stop its services. Retry both gates after the offset is released.

## Progress

- Synced `rebuild/trunk` through `cd5b638` into `track/qa` (merge `06b8150`), resolving the A track-note and guardian-IDOR conflicts while retaining both owners' requests and asserting both 404 and absence of the foreign allergy value.
- Reviewed WIP `7a39c59`; replaced the fixed 50-route/5-role crawl with rendered-navigation discovery, per-route HTTP/API/request/error checks, explicit queue completion, axe, and fixtures for every organization role, guardian/self, and all platform roles.
- Security review confirmed the skipped Web Push SSRF regression matches an unvalidated transport call; QA-SEC-004 records the synthetic reproduction and Track C request.
- Removed the crawler's unused exported role type after `npm run knip` flagged it; `npm run typecheck` and focused ESLint pass, while the remaining Knip findings belong to A/C/G/I.
- Added the 27-journey audit inventory, a 2,000-person import preview/commit/rollback journey, and a SafeSport guardian-inclusion browser journey. Guardian medical save/reload and cross-guardian medical 404 checks are also added. On the post-sync tree, `npm run typecheck`, `npm run lint`, and `git diff --check` pass.
- Targeted Chromium journeys and crawler remain unverified: `heavy.sh` exited before `webServer` started, and direct QA stack startup confirmed Track I owns all ports for the required offset. No other track containers were stopped.
- No range is ready for integration until the required Chromium merge gate can run.
- Audited the newly integrated Phase 13 federation slice: journey 25 exists and covers entries, shared-field schedule, result and standings, but the QA browser run is pending; filed QA-ACC-033, QA-ACC-034, and QA-SEC-007 for navigation discoverability and missing revocation/RLS regression evidence. Added a focused `test.fixme` navigation assertion for C to enable after wiring.
- Filed QA-ACC-035 after finding that `federation_sharing_guard()` allows camelCase `teamEntries`/`complianceStatus` while the shared schema and service persist snake_case. Existing tests exercise those keys, but runtime behavior remains unverified until QA Postgres is available.
- Filed QA-ACC-036: Phase 13 journey 25 submits both field windows but schedules one game only, so it cannot prove both clubs' availability affects the generated schedule.
- Audited the integrated Phase 11 journeys: journey 23 now records its volunteer acceptance flow as covered but awaiting QA execution; QA-ACC-037 asks H to exercise the donation acceptance path without the setup session.
- Static privacy audit found QA-SEC-009: a scoped director with an active org membership can read unrelated household volunteer ledger data because the ledger service checks membership but not role scope. Added a focused `test.fixme` request test; runtime verification is blocked by the QA stack collision.
- Phase 11 store audit found QA-ACC-038: the family store omits registration/team identifiers that the report requires, while the service trusts arbitrary caller-supplied team IDs. Added a paid family-order-to-report `test.fixme`; execution is pending the isolated database/browser stack.
- Phase 11 finance audit found QA-ACC-039: concurrent buyouts issue an invoice before the locked capacity check; a losing request can therefore leave an orphan payable invoice. Added a `test.fixme` asserting invoice lines remain in sync with buyout records.
- Selected isolated SSRF, stored-XSS, security-header, and `security.txt` Vitest checks pass (15 tests) using a temporary config without the PostgreSQL global setup; full database and browser suites remain blocked by the occupied QA offset.
- Synced trunk through Phase 11 commit `0ca39573` in merge `74e8a30`; resolved H's track note while retaining QA requests. The post-sync full typecheck/lint and changed-file pre-commit checks pass.
- Filed QA-SEC-008: `readMemberCompliance` has no real-Postgres test for the status-only allow-list, denied-sharing response, or dual-org audit.
- Re-ran `npm run knip` on the post-Phase 13 tree: 8 unused files, 44 exports, 28 types, and 1 duplicate. The new federation dead exports and demo helper are routed through the Track C quality-gate request.
- Post-Phase 13 `npm run typecheck`, `npm run lint`, and `npm run build` pass; build warns that the 1.35 MB app entry chunk exceeds Vite's 500 KB warning threshold. `npm run size` measures 404.93 KB gzip against a 200 KB limit. Targeted federation/crawler Chromium exits before test collection because its configured web server cannot start; the stack conflict remains with Track I.
