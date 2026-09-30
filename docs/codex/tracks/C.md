# Track C — files, adapters, and wiring
Status: working — local integration code head `ea5cc58e` includes C’s Vite `/site` route correction, A’s test-scoped Chromium notification grant, and D’s Phase 11, `/site.css`, JSONB fixture, Phase 14 evidence, and volunteer buyout lock updates; exact-head hosted verification is pending.
Branch: `track/integration` in `/Users/sammooney/Sport-trunk`
Hosted CI: runs `36698501721`, `36701650873`, and `36702271095` each passed the crawler routes after C’s Vite proxy correction. On `36702271095` (`c536e533`), E2E passed 114/115, including the 6.7-minute crawler; only the Chromium notification permission assertion failed. Its database/unit `test` and all static jobs passed. The same test/static result held on `36701650873` (`e522984e`), whose E2E passed 114/115 with the same notification failure. Run `36700407619` had the earlier skip-link fixture and permission failures.
Open integration work: exact-head hosted verification after `ea5cc58e` is pending. Run `36703489205` on `326938d3` has database/unit `test` and all static jobs green; E2E remains in progress. It tests A’s initial explicit pre-navigation grant but predates A’s newest `36fbb761`, which removes project-wide permission configuration and scopes the explicit grant to this sign-in test. Latest D fix `2dbe7f2c` keeps buyout queries on the lock-owning DB session. No GREEN result is claimed.


## Completed Track C work

- Track F restricted-file authorization: verified linked guardians can upload restricted credential and return-to-play evidence; owner/compliance downloads are authorized, every Restricted read is audited, and other readers receive 404.
- Track H chat attachments: active same-organization conversation members can upload and download images/PDF; image metadata is stripped; nonmembers receive 404 and Restricted reads remain audited.
- Chat attachment expiry is checked against the message operation clock, so a file valid at send time is not rejected because a fixed test time predates the machine clock.
- Track I Classes discovery: the family portal shell links to the generated `/me/orgs/:orgId/classes` route in desktop/mobile navigation with English and Spanish labels.
- Track J Federation discovery: Console Home uses the authenticated, organization-scoped capabilities endpoint to show Federation only to eligible roles; `/console/federation/:orgId` is linked without granting access from a guessed route. Federation's admin database pool is initialized before the web process scrubs `DATABASE_ADMIN_URL`.
- Fixed duplicate safety-center actions for owners with audit access and scoped the Federation journey's data-sharing controls to its named fieldset.
- Track G schedule discoverability: organization owners can open the nested schedule route from Console Home; public facility pages load layout images through the Files module's approved-public-layout endpoint.
- Track H provider IDs: email, SMS, and push adapters return provider message IDs when supplied; fake adapters return stable IDs. Mailpit SMTP reads `ATHLENTRY_MAILPIT_SMTP_PORT` (default 1025).
- Track F evaluator-photo authorization: sensitive person photos are readable only by an evaluator actively assigned to a session containing that participant, while both the event participant's consent and the person's current consent/photo link remain valid; authorized reads are audited.
- Track B season rollover composition: optional `SeasonRolloverExtras` contributions are collected in registered-module order and passed to the seasons router.
- Track K Phase 15 integration is included in `track/integration`: provider/key-derived `VITE_AI_ENABLED`, all four raw-upload OpenAPI media types, contextual Help navigation, and `ConsoleShell` wrapping for onboarding/import routes. The current integration browser assertions cover desktop/mobile import Help and disabled-AI behavior; hosted verification is pending.
- Public sponsor logo OpenAPI: documents the active placement image route with its accepted image MIME types and required surface parameters.
- Existing adapter wiring: raw Stripe webhook ingress and worker registration, finance module and routes, generated registry/OpenAPI and nested route discovery. Stripe remains test-mode only.
- SEC-SSRF-C-001: implemented in the Web Push adapter with provider-host validation, public-address checks for every DNS answer, and a pinned HTTPS agent to prevent DNS rebinding; regression tests reject unsafe hosts/addresses and verify the pinned lookup.
- Trunk CI repair is included in the combined integration candidate: C carries the zero-byte-safe deterministic UUID and private Action Center schema changes; the current hosted test/Knip result is pending for the integrated tree.
- Phase 15 remains owned by Track K; K's migration, onboarding/import routing, AI flag, Help journey, and raw-upload contract are now merged into `track/integration` at `037530e1` and await hosted verification on the combined tree.

## Wiring queue

- SEC-001: **implemented** — security headers are mounted before API/static routes; production security.txt requires configured staffed contact/policy values; Stripe/Turnstile and configured storage origins remain allowed and HSTS stays production-only.
- SEC-002: **implemented** — `a981e0d` and `8290731` generate permission/resource/scope metadata for every API operation, publish it through OpenAPI and the registry, validate metadata at app startup, and supply schema-valid query/path/body fixtures. The owner-aware permission matrix and tenant-fuzz browser tests are enabled and pass.
- SEC-003: **verified** — raw Stripe and Connect ingress is mounted before feature routers; the webhook router consumes raw bytes for signature verification.
- SEC-004: **implemented** — `/.well-known/security.txt` is served, production contact/policy values fail closed until configured, and CI scans full git history with gitleaks without posting PR comments.
- Track B: generated Programs/Teams/Facilities routes are present; shared Files request/result/record/download contracts and `FILE_INVALID` error envelope are implemented in the current worktree. `SeasonRolloverExtras` composition is implemented; H's volunteer copier can register its contribution when available. A-owned mutable-org expected-version migration remains with A.
- Track E: registration and finance routes are registered; after E merges new route descriptors, run migrations/codegen and OpenAPI then registry generation so route metadata and the permission matrix remain complete. Mount offer checkout when E supplies its persisted offer-checkout operation; current refund-approval and transfer-refund contracts are generated.
- Track OPS: implemented in the current worktree; focused real-Postgres health/metrics and job-registry tests pass.
- Track H: provider IDs, chat attachments and sponsor-logo authorization are implemented. `installment.failed` and `installment.final_notice` push/SMS fanout remains gated on a shared consent-aware durable delivery contract; existing finance notices queue email and in-app notifications.
- Track H chat-batching integration: `sendChatMessage` now persists `chat_messages.created_at` from its injected operation clock, keeping `last_read_at` and notification unread checks on the same timeline. The full real-Postgres chat integration file passes 12/12. H owns the surrounding chat/notification code and should preserve this contract when syncing its branch.
- Track K navigation and mobile Help: **implemented on the C branch** — console/portal root navigation aggregates onboarding and Help contributions, and the localized mobile Help link retains the current article, request kind, locale, and encoded source path. `web/src/generated/registry.test.ts` passes 2/2 and `web/src/ui/ConsoleShell.test.tsx` passes 1/1. K's provider/key-derived `VITE_AI_ENABLED` wiring is also present on this branch. Hosted Phase 15 WebKit acceptance remains unverified until the exact C branch is published and green; preserve `OrgShell` and the existing design tokens.
- Reviewed wiring requests addressed to Track A across the local track worktrees. D's website SSR, verified custom-host routing, and host-root robots/sitemap aliases are mounted by `createWebsitePublicRouter` before the production SPA fallback and have real-Postgres route coverage. F's offer checkout remains blocked on E's persisted operation; H installment-alert fanout remains gated on its consent-aware durable delivery contract. K contextual Help links and upload MIME overrides are implemented on C's branch.
- SEC-002 follow-up: nonmembers now receive concealed 404s for chat history/conversation/moderation and finance staff/template routes; active members without the required finance role still receive 403.
- Review requests addressed to Track A across all `docs/codex/tracks/*.md` for wiring ownership; gated requests remain listed above until their owner contracts land.

## Requests from SEC

- SEC-002: **implemented** — generated operation permission/resource/scope metadata, foreign-resource fixtures, reviewed role matrix, OpenAPI/registry publication and 404 concealment are in the merged security commits; the SEC completeness checks pass.
- SEC-SSRF-C-001: **implemented** — endpoint validation and pinned public DNS addresses are committed in C; adapter regressions and the enabled synthetic loopback Chromium spec pass.
- SEC-CI-001: **implemented** — CI scans full git history on pull requests and pushes to protected branches without PR comments; its regression spec is enabled and passes.
- SEC-KNIP-C: **implemented** — documented Render backup and operator restore-drill scripts are Knip entry points; the Files upload parser and unconsumed enum exports are private; `@sentry/node` is classified as a dynamic optional runtime dependency. Knip reports no C-owned findings.
- QA-SEC-006: **implemented on the C branch** — `scripts/check-sql-raw.mjs` parses TypeScript ASTs in `server/src` and `shared/src`, rejects interpolated/concatenated and unreviewed dynamic `sql.raw` fragments (including bracketed access), and runs in the CI static matrix. Its self-check and current source scan pass; focused report query coverage passes 10/10 against C Postgres.

## Requests from K

- Provider-derived `VITE_AI_ENABLED`: implemented; it is true only for configured Anthropic provider plus a nonblank key, with configured/disabled state coverage.
- Phase 15 raw-upload OpenAPI body: implemented for `application/octet-stream`, `text/csv`, `application/zip`, and XLSX without changing request limits or response contracts.
- Console/portal Help and onboarding navigation: implemented; localized contextual Help preserves article, request kind, locale, and encoded source path. The current K branch also wraps onboarding/import screens in the existing `ConsoleShell`; no design tokens or styles changed.
- Public website robots-policy operation: K's branch carries the regenerated `text/plain` OpenAPI operation for `/api/v1/website/public/{orgSlug}/robots.txt`; generated output is refreshed after all requested branches merge.
- The merged Phase 15 journey covers contextual import Help from desktop and mobile, verifies Concierge import remains selected, and checks mobile Help discovery. Focused registry and shell tests are recorded above.

## Verification and environment

- Use real PostgreSQL integration tests; do not skip or weaken DB tests. Run full tests and Playwright only through `~/athlentry-sprint/heavy.sh`.
- Post-sync C gate (2026-09-28, on `d52e4c83`): typecheck, lint, build, size (145.07 kB gzip / 200 kB), real-Postgres Vitest (279 files / 1,006 passed / 1 existing skip at two workers), Chromium (53 passed), WebKit mobile (49 passed / 4 existing conditional skips), Knip (three configuration hints; no project findings), and high/critical dependency audit pass. Registry/OpenAPI were regenerated after migrations and have no follow-up diff. No tests were weakened. Hosted run 36370435506 is on older `1a82760e`; it reports five e2e failures (three design snapshots and two schedule-stats journeys), five database-test failures (class enrollment transition, deterministic UUID, people date fixture and sponsor lookup) and Knip findings. D owns the remaining Linux parity baseline; the synchronized C checkout passes the stale test and Knip checks locally.
- Partial verification after syncing C through `91614aaa`: typecheck passes; full real-Postgres suite passes 279 files / 1,007 tests with one existing skip; targeted historical CI files pass; the chat service file passes 12/12; `npm run registry`, `npm run openapi`, database codegen, and Knip complete (three configuration hints, no project findings). Full lint, browser, build and locked merge gates remain open. The historical hosted run is for `1a82760e`, not the current local trunk head.
- The initial post-sync real-Postgres run found two chat failures. C fixed both clock seams without changing assertions or tolerances; the full suite rerun passes.
- C stack: `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=510` (Postgres `127.0.0.1:5942`); after applying current trunk migrations, codegen introspected 242 tables.
- Full tests and Playwright must continue through `~/athlentry-sprint/heavy.sh`; database and browser coverage is not skipped or weakened.
- The isolated C stack is `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=510` (Postgres `127.0.0.1:5942`); latest `91614aaa` migrations applied and codegen introspected 242 tables.
- Historical hosted run 36370435506 covered older commit `1a82760e` and failed test, e2e and Knip. The current final-gate query could not reach GitHub; no current hosted CI result is claimed.


## Final gate snapshot — 2026-09-28, 22:05 CDT
- Local gate ran on the candidate based on `6dbb0e2a4deed06b1196b73dd9a6d2ffa14aff60`, Track D `bec47e21`, the focused Track I class-tenant commits, and C registry/navigation/contract cleanup. Isolated PostgreSQL used `COMPOSE_PROJECT_NAME=athlentry_c_gate`, `PORT_OFFSET=5500` (host port 10932).
- Full real-Postgres tests passed (308 files; 1,106 passed; 1 existing skip); Chromium 60 passed / 3 skipped; WebKit 56 passed / 7 skipped; typecheck, lint, build, size (150.42 kB gzip), registry/OpenAPI generation, Knip, audit threshold, and source scan passed.
- Launch gate is not ready: coverage thresholds fail; three SEC-002 e2e checks remain skipped; load/restore/Lighthouse evidence and route crawler are missing; phase acceptance remains incomplete. Latest hosted run `36489602298` is on old SHA `91614aa` and failed test, e2e, OpenAPI freshness, and Knip; the current candidate has not been pushed or checked by hosted CI. Local `main` remains `d0f59a1c44e499dc69455ed3ad3e0a2dae9883de`.

## CI status
- Run `36651183363` on `1f6468e3` passed database tests and all static jobs but failed 28 Chromium e2e cases (2 flaky). C-owned finding: `e2e/security/permission-matrix.spec.ts` expected `post_api_v1_waivers_orgs_orgId_waiverId_retire`, missing from the generated matrix. `npm run registry` regenerated the missing 27-line row; the exact matrix fix is included in this commit.
- Run `36652124343` on `3dfefb49` passed database tests and all static jobs, including Knip; Linux reference capture succeeded. Its e2e suite was still running at last check. Run `36652587192` on the preceding docs checkpoint is the newest hosted run; current code will be rechecked after this generated-file fix is committed.
- Latest hosted candidate `3dfefb49151342a513b79a6e9edcfd4150876bfe`, run `36652124343`: database tests passed; typecheck, lint, build, size, Knip, SQL-raw, OpenAPI, registry, audit and secret scan passed; Linux parity-reference capture passed; e2e tests remain in progress. This is not yet a GREEN result.
- The integrated branch includes A, G, K, and D's requested heads; D's latest cleanup change merged in `3dfefb49`. A/G/K have no additional branch-only commits beyond the integrated history.
- Current candidate before the parity-launch correction: `1f6468e35126da0f7a475d3e06f503b2545609c9`; hosted run `36651183363` was still in progress at last poll. Earlier run `36650706428` passed test and all static checks but failed Linux legacy reference capture because Vite was invoked through a missing internal path.
- C corrected the e2e job to install development dependencies explicitly and invoke the repository Vite CLI from the repository root; `/Users/sammooney/athlentry-sprint/heavy.sh npm run typecheck` passes, `bash -n e2e/visual-reference/linux-baseline.sh` passes, and the local Vite CLI reports its version. Hosted CI must verify the corrected runner.
- Latest trunk run `36636307104`, head `5cdee29e1d12cc9529269e9250680e49b8f42fbc`: `test` failed only at `server/test/registration/team-entries.test.ts` because `stableUuid` rejected valid zero digest bytes; Knip failed on the unused exported `actionCenterBulkActionSchema`; e2e failed on two Linux parity comparisons. Typecheck, lint, build, OpenAPI, registry, size, audit, and secret scan passed.
- Latest exact C run `36645798688` verifies head `960d5db0d5370aa79a9625180d4bd7adee6bf16d`: test and every static check pass; e2e fails at `e2e/design/parity.spec.ts` for the 390px public-site shell (9.63% against the unchanged 6.5% limit) and `ui-team-1440` (21 differing pixels). D owns the Linux references; macOS references and tolerances must remain unchanged.
- Track A run `36647507025`, exact SHA `c51245b7d327f987837bacaec6a24326d21a79be`, completed red: test passed; Knip reports the unused export `actionCenterBulkActionSchema` at `server/src/modules/action-center/schema.ts:10`; e2e repeats the 390px public-site and `ui-team-1440` parity failures. Other static checks pass.

## CI request
- Track D: C run `36645798688` and A run `36645814799` both fail `e2e/design/parity.spec.ts`: the 390px public-site shell differs by 9.63% (assertion remains `<0.065`; only `e2e/visual-reference/public-site-home-390.png` exists, with no Linux-specific reference). That helper does not attach its rendered PNG, so the trace exposes only a lossy 217px-wide screencast frame; capture the exact Linux render or use the CI reference-generation environment before adding a Linux baseline. `ui-team-1440` differs by 21 pixels: expected Linux SHA-256 `1d0cecf6848a2bbc0c238fc10f83b04fea95a295cde2ba6cc4408ce5b7eb7d60`, actual C CI artifact `/tmp/athlentry-366457-c/data/7edf68275301be0b3e77d9c3e7fe331cb2040a7d.png` SHA-256 `88080ea8cafb8b4eab4a8e5237c249a0c4d20aea28350b4780c44e333b2cdb66`, diff `/tmp/athlentry-366457-c/data/0562962eb75ebd08ad261bdb555b877675645de4.png`. Knip on A SHA still exports unused `actionCenterBulkActionSchema`; the private-schema fix is in D/C but not in A's current tree. Preserve macOS references, thresholds, and token assertions.
- Integration queue: A's current head `c51245b7` completed CI `36647507025` RED (test passed; Knip and D-owned parity e2e failed). G `9b00311e`, K `ad768b51`, and D `20cd591f` have no hosted runs for their exact heads. All queue branches contain trunk `5cdee29`, but no candidate is eligible until its exact hosted CI is GREEN. The interrupted G merge was aborted; its branch commit is preserved.
- C's committed SQL-raw guard change and follow-up hardening add the AST-backed static guard to CI and parameterize the report aggregate/sort assembly. The scanner self-check/source scan and real-Postgres report query tests (10/10) pass locally; exact C run `36645798688` confirms the `sql-raw` CI job, full test job, and all static checks pass on this branch.

## Current sync verification — 2026-09-29
- Candidate base: local trunk `cb7eba7a` (D merged; local trunk is not pushed). Isolated real PostgreSQL: `COMPOSE_PROJECT_NAME=athlentry_c_gate`, `PORT_OFFSET=5500`, Postgres `127.0.0.1:10932`; Compose uses C's own data volume and a dedicated subnet because the host's default Docker address pools are exhausted.
- `npm run typecheck`, full `npm run lint`, and `npm run build` pass. Full real-Postgres Vitest passes 314 files / 1,126 tests with one existing skip. Chromium passes 65/65; WebKit passes with four existing conditional skips; the full `test:e2e` command exits successfully.
- `npm run size`: 150.44 kB gzip under 200 kB. Registry: 40 server modules, 6 integrations, 9 web features. OpenAPI regenerated. Knip has three configuration hints and no project findings. Production audit passes high/critical threshold; two moderate `uuid` advisories remain through `exceljs`.
- No tests or tolerances were weakened. The first full WebKit run found an ambiguous `getByRole('status')` in the Action Center journey; the locator now filters for the expected success text. Targeted WebKit and the full browser rerun pass.

## Current branch verification — 2026-09-29
- C is synchronized with `rebuild/trunk` at `5cdee29`; branch tip `960d5db0` contains the two SQL-raw guard commits and has no unresolved merge paths. Exact hosted run `36645798688` passes test/static and fails only on D-owned parity e2e checks.
- `/Users/sammooney/athlentry-sprint/heavy.sh npm run typecheck` and `/Users/sammooney/athlentry-sprint/heavy.sh npm run lint` pass. The targeted registration Postgres integration passes 1/1 with `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500`, and host port 5932. `ConsoleShell.test.tsx` passes 1/1; `web/src/generated/registry.test.ts` passes 2/2. Registry and OpenAPI generation complete successfully.
- The isolated C Docker stack was stopped after the targeted Postgres test. No full suite or Playwright suite was run locally under the CI-first rules; no coverage was skipped or weakened.
- Real-Postgres Files tenancy/RLS integration `server/src/modules/files/service.integration.test.ts` passes 10/10 on `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500` (Postgres `127.0.0.1:5932`); the isolated stack was stopped afterward.
- Mailpit configuration regression in `server/src/integrations/email/sender.test.ts` passes 6/6, including `ATHLENTRY_MAILPIT_SMTP_PORT` selection and its 1025 fallback; the same isolated stack was stopped afterward.

## Requests from QA

- **QA-QUAL-001 hosted CI follow-up:** run `36640228008` reports Knip RED on QA head `910e0b0c`; retrieve the exact current Knip list and assign any remaining findings before claiming the gate green.
- **QA-ACC-064:** derive the optional AI client flag from `AI_PROVIDER` and key presence at build time without exposing the key; the C branch implements this and includes configured/disabled state coverage.
- **QA-ACC-065:** integrate the public website route contract through the shared app, including `/site` SSR and tenant-safe verified custom-domain resolution; verify after the D branch is merged.
- **QA-ACC-053:** C now generates all registered route patterns with actor-context and synthetic fixture-key expectations, covered by a registration parity test. QA must consume the catalog in its crawler and seed the documented coach/team-staff, assigned-official, and volunteer records; see `docs/codex/qa/DEFECTS.md`.
- **QA-SEC-001 / QA-SEC-016:** generated operation metadata and same/foreign-tenant fixtures are implemented on C; confirm full current matrix method coverage in the integration CI.
- **QA-SEC-019:** verify route-level allowed/denied roles and scoped-role boundaries against declared permission-matrix predictions; see `docs/codex/qa/DEFECTS.md`.
- **QA-ACC-050:** refresh launch-gate evidence against the integration candidate after QA crawler results and hosted CI are available; keep item 10 failed until the all-role route results are current.

## Federation route-crawler repair — 2026-09-29

- The prior hosted run `36653551397` on `c0dd2e28` passed database tests and all static jobs. E2E failed when organization-home pages probed Federation relationships for registrar and communications roles, and Federation pages eagerly requested read APIs outside finance, scheduler, and compliance roles. Those endpoints correctly returned concealed 404s; the route was mounted.
- Commit `ecf9f08a` adds an authenticated, organization-scoped capabilities endpoint and shared response schema. The home screen uses its relationship capability instead of probing the protected relationships list. The relationships list is readable by Federation read roles and submit-entry roles so registrars can select a league. The Federation console loads only data routes authorized by the response and limits visible sections by capability; protected resource routes retain their existing 404 behavior.
- Generated server route metadata and OpenAPI were refreshed. The real-Postgres mounted-API test `server/test/federationConsoleRoutes.integration.test.ts` passes 1/1 on `COMPOSE_PROJECT_NAME=athlentry_c PORT_OFFSET=500`; finance allowed reads return 200, restricted reads remain 404, and registrar relationship/submission reads return 200 while the member directory remains 404. `web/src/console/Home.test.tsx` passes 1/1.
- `/Users/sammooney/athlentry-sprint/heavy.sh npm run typecheck` and `... npm run lint` pass. The isolated Docker stack was stopped. No local Playwright or full suite was run. Hosted CI for `ecf9f08a` is pending.

## Federation crawler role/API regression — 2026-09-29

- The older hosted crawler failures were role-denied bootstrap requests: finance, scheduler, compliance, registrar and other roles received concealed `404`s when the console requested resources outside their returned capabilities. The protected API denials are correct; the UI must omit those requests.
- `web/src/console/federation/access.ts` now owns the resource-to-capability map used by `FederationConsole`. The real-Postgres API test imports this same map and checks the actual allowed request set for all 11 organization roles in the route crawler, so a capability/route mismatch reports the role and resource.
- `server/test/federationConsoleRoutes.integration.test.ts` passes 2/2 on `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500` (Postgres `127.0.0.1:5932`). `/Users/sammooney/athlentry-sprint/heavy.sh npm run typecheck` and `/Users/sammooney/athlentry-sprint/heavy.sh npm run lint` pass. The isolated stack was stopped after the test. No Playwright or full suite was run locally.
- The exact hosted failure named by the latest orchestrator note is already corrected by capability filtering; this update adds shared mapping and all-role regression coverage. The current observed e5b6 run's remaining federation-specific failure is QA-ACC-033 waiting for Operations navigation, not a federation API response. CI for this update remains pending.

## Federation route crawler follow-up — 2026-09-29

- The crawler's non-owner fixtures create a separate active org member with an org-scoped role assignment. `server/test/federationConsoleRoutes.integration.test.ts` now uses that same fixture shape (and seeds the actor's program) when checking the capability-filtered bootstrap API set for all 11 organization roles.
- The focused real-Postgres test passes 2/2 with `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500` (Postgres `127.0.0.1:5932`); `/Users/sammooney/athlentry-sprint/heavy.sh npm run typecheck` passes. The local fix does not run Playwright.
- The capability-filtering UI change is already on this branch at `0e6d9ac8`. The supplied `/Users/sammooney/athlentry-sprint/ci/integration.txt` was last updated at 22:00 and reports the prior `e5b6e7a3` run / pending `4b7870fe`, so it does not contain the cited `1f6468e3` / `3dfefb49` crawler failure details or verification for current `d8b1e4dc`. Hosted verification remains pending; no GREEN result is claimed.

## Integration route inventory — 2026-09-29

- `scripts/registry.mjs` now generates a lightweight inventory for all 121 registered web route patterns, including dynamic parameter names, synthetic fixture kinds, source route files, and expected actor contexts. This gives QA a route catalog for unreachable detail pages without importing page components into the crawler.
- `web/src/generated/registry.test.ts` checks both directions against the registered React Router routes and verifies linked-guardian, coach/team-manager, treasurer, assigned-official, volunteer and platform-staff contexts plus fixture keys. Focused test passes 3/3; guarded typecheck and lint pass. No full suite or Playwright run was started locally.
- D's public standings embed fix (`835746b3`) was merged in `390625cd`; A has no code commits ahead, only sync merges.
- D's public sponsor/fundraiser routes and generated-page sitemap updates (`8b48fa19`, `4410b60c`) were merged in `e1e282fc`; generated website coverage awaits hosted CI.
- The CI-reported Northstar seed zone `America/Minneapolis` is invalid; C changed it to `America/Chicago` and added `validateDemoTimezones()` before seeding. `server/test/demoSeeds.test.ts` passes 2/2, including a failure-message regression for invalid zones; hosted verification is pending.
- The family `/portal/.../notifications` crawler failure was caused by staff-only membership gating despite the portal route serving verified linked guardians. Notification inbox/preferences now admit a verified active person link in that organization while retaining account-only rows and foreign-org 404 concealment. The real-Postgres `server/src/modules/notifications/routes.test.ts` passes 5/5.
- The family `/me/orgs/:orgId/classes` route failure was caused by class portal APIs requiring organization membership even for verified linked guardians. Class portal access now accepts active verified self/guardian links, and browse requests verify any person filter belongs to the account. `server/src/modules/classes/classes.integration.test.ts` passes 20/20 against real Postgres, including a guardian with no organization membership, own-child access, and foreign/unlinked denial.
- Latest integration CI `36670075707` is running on `95faf321`; the last completed run `36668726068` on `30555e56` is RED in e2e for two family classes pages and the invalid Northstar timezone. The timezone correction is included in the current running run; class/notification and D website changes are newer and still await hosted verification.

## Current integration follow-up — 2026-09-29

- The focused real-Postgres federation API test passes 2/2 on `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500` (Postgres `127.0.0.1:5932`). It sends the same capability-approved bootstrap requests as the console for all 11 crawler roles; every allowed request returns 200 and protected resources remain concealed. The capability filter is committed at `0e6d9ac8`, with crawler-shaped membership fixtures at `4d15f738`.
- The latest completed CI snapshot was run `36663830530` on `4d15f738`; its remaining e2e errors are family documents, classes, and invalid `America/Minneapolis` timezone data. It shows no Federation API failures. A's family fixes are integrated at `31700147`, and D's seven-commit batch at `6212934`; D's later locale follow-up `fdab5e6c` is integrated as `94c4e9fb`. At last read, CI was PENDING on `d5d1aacb`; no hosted result is available yet for local head `807faf13`, which also includes D’s locale follow-up `94c4e9fb`.
- Track D's storage-adapter wiring request is implemented across production web and worker startup. Environment-selected private S3 storage reaches mounted Files and Exports routes and registered jobs; jobs receive the configured storage, database, clock, and `withOrg` runner. Local development retains local disk and tests can select memory storage.
- Targeted checks pass: storage adapter (9/9), production config (3/3), worker runtime injection (1/1), job registry (4/4), Federation API (2/2), and locale completeness (2/2). `heavy.sh npm run typecheck` and `heavy.sh npm run lint` pass. The merge hooks also passed typecheck after each A/D integration. Full suites and Playwright remain for hosted CI.


## Crawler and test-job stabilization — 2026-09-30

- Merged Track A and D syncs into the local integration candidate (`111d0b2e`, `758a22fe`). The failing hosted run `36671455807` is on pre-fix `758a22fe`; the report is in `/Users/sammooney/athlentry-sprint/ci/integration.txt`.
- The failed `test` job showed `website/service.integration.test.ts` calling standings through the global `withOrg` database instead of the injected test runner, producing a SCRAM password error. `getStandings` now accepts the injected org runner, and public website embeds pass it through.
- The same job showed the per-file Postgres database teardown hook timing out while server test files ran in parallel. The server Vitest project now runs one file at a time; tests remain enabled and assertions/timeouts are unchanged.
- Focused Postgres testing exposed a date-boundary issue in tuition billing: date columns were compared with JavaScript timestamps, which could omit an enrollment on the period-end day. The query now compares date-to-date, and the fixture uses the current billing period. `classes.integration.test.ts` passes 20/20.
- The crawler previously waited only for API requests already started at the time its pending set became empty, for 250 ms. Delayed lazy-route requests could begin after its listeners were removed and be charged to a later route. It now waits for all same-origin requests (excluding the long-lived event stream) to finish and remain idle for 500 ms. The route-crawler tests run serially to avoid crawler fixture load overlapping within that suite.
- The failed e2e log also reports `/api/v1/finance/me/payment-methods` returning 503 when no payer Customer exists. Payer-method and Connect services now receive lazy gateway providers, so reads with no Stripe account and already-busy reservations do not initialize an unavailable Stripe dependency. Unit regressions cover both paths.
- Connect status had another provider-dependent read: it called Stripe even though onboarding and `account.updated` already persist the status. `GET /connect/status` now returns that persisted status; the real-Postgres route regression verifies the read adds no Stripe call. Commit `0e3d73fb`.
- Real-Postgres targeted tests pass: website service 13/13, finance routes 18/18, classes 20/20; payer methods 6/6 and Connect service 6/6. `/Users/sammooney/athlentry-sprint/heavy.sh npm run typecheck` and `... npm run lint` pass after the crawler update. `git diff --check` passed before commit.
- Commits: `6f832444 fix(test): stabilize database integration seams`; `d1f93517 fix(e2e): wait for crawler network idle`; `0e3d73fb fix(finance): serve connect status from synced state`. `knip` was green on the pre-fix CI run. No full suite or Playwright run was started locally under CI-first rules; no tests were skipped or weakened.
- D's Phase 14 Lighthouse CI request is implemented in `.github/workflows/ci.yml`: an independent Ubuntu 24.04 job installs Chromium, runs `npm run perf:lighthouse:website`, and uploads `perf/results/phase14-shared-app/` with `if: always()`. Score evidence awaits the hosted run.
- Local Postgres stack: `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500`, host port 5932. The current hosted CI report is stale and still describes the pre-fix head; the exact committed candidate awaits hosted CI. No push was performed.

## E2E determinism and integration repair — 2026-09-30

- Run `36676094411` on pre-fix head `41dc3f8f` completed with `test` and static jobs passing; only E2E was red. C fixed the federation navigation spec to exercise the shared console shell that owns the asserted Operations navigation.
- Federation roster counts and submitted snapshots are now returned only while the active member relationship grants `rosters`. The list, detail, and member-team responses hide snapshot/count metadata as soon as the member revokes that permission; the console omits the count when it is not shared.
- Federation fee void now updates the assessment, invoice, and audits in one caller-owned Postgres transaction. A blocked invoice void (active installment) leaves the assessment invoiced and the invoice open. `PostgresInvoiceRepository.voidInTransaction` supports this atomic composition.
- Playwright starts each browser-project run from a fresh e2e schema and seed. The opt-in `db:seed --profile e2e --reset` recreates `public` and `pgboss`, reapplies app-role grants, then migrates/seeds; ordinary seed invocation remains non-destructive. CI runs tests with one worker so shared fixtures do not race.
- Commits: `bf8b84f2 fix(federation): enforce roster revocation and atomic fee voids`; `0fd83c1b test(e2e): reset seeded state between browser runs`.
- Verification: `server/test/federation.test.ts` passes 21/21 against real Postgres on `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500`; e2e schema reset completed all migrations and seed, followed by an app-role seed read. `heavy.sh npm run typecheck` and `heavy.sh npm run lint` pass. The isolated stack is stopped; no local Playwright/full suite was run.
- A's `Requests from C` note assigns class-security, volunteer-ledger, and chat-safesport E2E failures. D's note assigns uniform-report and buyout-race E2E failures. Those other-track fixes remain outstanding; C has not edited their implementation paths.
- Hosted verification for `bf8b84f2` and `0fd83c1b` is pending; neither commit was pushed, and no all-green status is claimed.

## Current integration follow-up — 2026-09-30

- Track A merge `27f23b52` brings the requested class, volunteer-ledger, and SafeSport authorization fixes. The real-Postgres class regression initially hit a duplicate active instructor fixture; `a3ae2795` removes that duplicate insertion while preserving the guardian-denial assertion.
- Track D merge `2b1ceb68` brings the requested family-uniform registration association and concurrent volunteer-buyout repairs. The merged volunteer service retains both A's scoped-ledger authorization and D's separated buyout aggregation/advisory lock.
- Focused real-Postgres checks on `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500` pass: classes 21/21, chat service 12/12, volunteers 4/4, store 8/8, and website service 13/13. The isolated Docker stack is stopped.
- `heavy.sh npm run typecheck` and `heavy.sh npm run lint` pass on the combined A/D tree; merge hooks also passed typecheck. No full test suite or Playwright run was started locally under CI-first rules.
- Track D's `StorePortal.test.tsx` passes 2/2 on the current integration candidate.
- Track A's sign-in E2E commit `0300bdc5` grants Chromium's notification permission while keeping fake service-worker/push providers; the browser assertion awaits hosted CI, and no real delivery is used.
- The E2E determinism changes remain in `d1f93517` and `0fd83c1b`: route-crawl visits wait for all same-origin requests to settle plus 500 ms of quiet, crawler tests are serial, CI E2E uses one worker, and each browser-project startup resets and reseeds the E2E schema. Exact hosted verification is still required to confirm the moving route failures are resolved.
- Route visits now also wait for visible `aria-busy="true"` data regions to clear before the idle check and link collection; the crawler still asserts on every same-origin HTTP/request failure, page error, and axe violation.
- `ci/integration.txt` reports run `36681876874` in progress on `df0020a0`, before D's StorePortal test and A's notification fix; no hosted result exists yet for `de95fbaa`.


## E2E ownership split and Phase 13 API repair — 2026-09-30

- The 01:03 orchestrator note assigns C `e2e/federation.spec.ts`, `e2e/phase13-fee-void-atomicity.spec.ts`, and `e2e/security/federation-sharing-revocation.spec.ts`; A owns the class-security, volunteer-ledger, and SafeSport specs; D owns the uniform-report and buyout-race specs. Requests were recorded in A.md and D.md.
- The fee-void failure was an API-boundary bug: `PostgresInvoiceRepository` raises typed 409/404 errors without Federation's required error code, so `sendModuleError` serialized the blocked void as 500 although the database transaction correctly rolled back. Federation now maps those invoice errors to Federation errors; a mounted real-Postgres API regression asserts 409 and the unchanged invoiced/open state.
- Added a mounted real-Postgres route regression that repeats the federation sharing-revocation API sequence and verifies team-entry access remains while roster counts, snapshots, and personal roster details disappear immediately. The existing `server/test/federation.test.ts` remains green (21/21).
- Verification on `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500` (Postgres 127.0.0.1:5932): `server/test/federationConsoleRoutes.integration.test.ts` passes 4/4; `server/test/federation.test.ts` passes 21/21; `heavy.sh npm run typecheck` and `heavy.sh npm run lint` pass. No local Playwright run was started.
- The checked-in `/Users/sammooney/athlentry-sprint/ci/integration.txt` still describes run `36682424875` / earlier head `3a7d76c8`, and does not include the 01:03 failure list or this fix. Hosted verification is pending; no CI-green claim is made.


## Permission-matrix CI follow-up — 2026-09-30

- The integration snapshot read at 02:52 CDT reports run `36685292605` in progress on `eff51c36`; the last completed run `36683545757` on `f5799684` failed E2E and static size. It lists the D skip-link journey, chat-safesport, Phase 13 fee-void, and C permission-matrix E2E failures. The in-progress run includes the fee API fix but predates A `0cb63a4`, D `12289a1`, and the current generated-matrix repair; the local head is `12289a1` plus those generated changes.
- The 01:03 owner-supplied E2E split separately names the C federation and sharing-revocation journeys, the A class/volunteer/chat journeys, and the D uniform/buyout journeys. The local report has since refreshed to a different head/failure set; no hosted result for the current candidate is available.
- The permission-matrix failure was caused by two new website API operations present in OpenAPI but missing from the generated matrix: public news detail and public facilities. `npm run openapi` and `npm run registry` refreshed generated metadata, the security matrix, and route inventory. A structural comparison now finds all 812 OpenAPI operations represented exactly once with matching permission/scope and no extra rows; both added rows match `public.access`. `web/src/generated/registry.test.ts` passes 3/3.
- C's mounted fee-void and roster-revocation API regressions pass in the focused real-Postgres file (4/4), and the Federation service test remains 21/21. The generated-route test passes 3/3; `heavy.sh npm run typecheck` and `heavy.sh npm run lint` pass after the generated-file refresh. No local Playwright/full test suite was started.


## Integration update — 2026-09-30 03:15 CDT

- Integrated D’s committed public website route splitting as `09f9b611`. `web/src/site/routes.test.ts` passes 5/5; guarded typecheck and lint pass. The hosted static size result is still pending.
- Integrated A’s `3b2e914c` sanitized Web Push response contract regression without reverting D’s site route splitting. `server/src/modules/auth/routes.test.ts` passes 2/2 against the isolated real PostgreSQL stack (`COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=500`, host port 5932). Its push adapter is fake; no external delivery occurs.
- The latest checked-in CI report is still run `36687088431` in progress on `8a15cacc`; it predates `09f9b611` and A’s current auth test. The previous completed run on `12289a1f` fails only in e2e and static size, with details predating the latest fixes. Hosted verification for the current tree remains pending.
- No full test suite or Playwright run was started locally; no assertions were skipped or weakened.


## D skip-link determinism update — 2026-09-30 03:20 CDT

- Integrated D’s `a0e0c44a` fixture correction, which explicitly sets the published organization and browser language to English before checking the English skip-link label. The assertion remains intact; `/Users/sammooney/athlentry-sprint/ci/integration.txt` still reports run `36687088431` in progress on `8a15cacc`, so hosted confirmation is pending.
- `heavy.sh npm run typecheck` passes on this update. The exact browser journey remains for GitHub CI; no local Playwright run was started.


## A notification-permission fix — 2026-09-30 03:21 CDT

- Integrated A’s `85ab1b56` sign-in E2E fix. Chromium grants notification permission to its isolated test context; the test still uses a fake service worker and push provider, so it cannot deliver real notifications.
- The available run `36688318120` is still in progress on `09f9b611` and does not include this change. Hosted confirmation is pending; local Playwright remains disabled by the CI-first rules.


## A sign-in permission assertion follow-up — 2026-09-30 03:32 CDT

- Integrated A’s `55bdfc3b` refinement: the Chromium test now asserts that notifications are granted after the user enables browser notifications and the fake device-registration request completes. The synthetic service-worker/push endpoint remains local to the test; no real notification is sent.
- Run `36689550628` is still in progress on `468b01f5` and does not include this refinement. The latest completed run `36688318120` on `09f9b611` reports only skip-link and sign-in E2E failures; static size passes. Hosted verification is pending, and no local Playwright run was started.


## Hosted E2E follow-up — 2026-09-30 03:45 CDT

- Run `36690800467` on `d0d69620` completed with all jobs green except E2E. The public-site artifact showed Vite's SPA fallback instead of the API's SSR page because `/site` was not proxied; C fixed this in `ca5c509c`, preserving Vite handling for `?app=1`. Exact-head hosted verification remains pending.
- A's `55bdfc3b` moved the permission assertion after fake push registration, but `Notification.permission` still reads `denied` after the device-registration request. The Playwright artifact snapshot says `Browser notifications enabled on this device`; A is asked to resolve the browser permission-state mismatch while preserving the assertion and fake-only delivery.
- Current code head `ca5c509c` includes the Vite route fix; it has not been pushed or run in hosted CI. No full suite or Playwright run was started locally.
- The recent completed reports do not list C-owned Federation, fee-void, or sharing-revocation failures. Focused API/Postgres and navigation component regressions remain green; no CI-green claim is made for current head.


## Integration update — 2026-09-30 04:12 CDT

- Merged A’s `fix/a` branch as `16673ed`, including `3a85deba` which scopes Chromium’s notification permission grant to the configured app origin, and A’s Phase 2 import acceptance fixture. Merge hooks passed ESLint, Prettier, and typecheck.
- The last hosted run `36690800467` on `d0d69620` predates both the `/site` proxy fix `ca5c509c` and A’s origin-scoped permission change. Its test, static, and Knip jobs passed; E2E failed on the unavailable public-site SPA fallback and denied permission read. The exact `16673ed` hosted result is pending.
- No local Playwright or full suite was run; no assertion was weakened and no push was made.

## Integration CI repair — 2026-09-30

- The earlier route and journey errors were stable across all retries, not crawler timing noise. C narrowed the dev proxy in `647cfc32`: only `/site/<org>` uses API SSR; `/site.css`, `?app=1`, and nested site journeys stay in Vite so Playwright’s deterministic API mocks are honored. Hosted run `36698501721` then passed crawler and fundraiser journeys.
- The skip-link home failure was a separate fixture issue: `e2e/design/parity.spec.ts` inserted `blocks: []`; node-postgres sent the JS array as a PostgreSQL array literal, which PostgreSQL stored as JSONB `{}`. D fixed this with `JSON.stringify([]) as unknown as Json` in `17e54587`; all keyboard/focus assertions remain intact. Hosted run `36701650873` passed the skip-link path, verifying the fixture fix.
- Runs `36698501721`, `36700407619`, `36701650873`, and `36702271095` reported Chromium notification permission `denied`; the `36700407619` trace confirms the context had configured permission, the app origin was `https://127.0.0.1:5173`, and `/sign-up` returned 200. A’s `418b28f0` adds an explicit pre-navigation origin grant while preserving both permission assertions and fake-only push delivery. A then removed redundant project-wide permissions in `36fbb761`; the exact-head run is pending.
- `647cfc32` passed `/Users/sammooney/athlentry-sprint/heavy.sh npm run typecheck` and `/Users/sammooney/athlentry-sprint/heavy.sh npm run lint`. Full E2E remains hosted-only per CI-first rules. The database/unit `test` job and all static checks passed on `36701650873`, `36702271095`, and `36703489205`. Exact integration head `ea5cc58e` merges A `36fbb761` and D `2dbe7f2c`; hosted verification will follow the `INTEGRATION READY` marker.
INTEGRATION READY ea5cc58e
