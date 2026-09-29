# Track C — files, adapters, and wiring
Status: working (current trunk integration candidate passes local merge gate; launch gate remains open)
Branch: `track/c-adapters`
Current: trunk candidate is based on `6dbb0e2a4deed06b1196b73dd9a6d2ffa14aff60`, with Track D through `bec47e21`, four focused Track I class-tenant fixes, and C registry/navigation/OpenAPI/Knip cleanup. The local merge gate passes typecheck, lint, full real-Postgres tests (308 files / 1,106 passed / 1 existing skip), Chromium (60 passed / 3 skipped), WebKit (56 passed / 7 skipped), build, size, Knip, registry/OpenAPI generation, and audit threshold. Track C's full implementation at `aa538816` remains unmerged (46 commits ahead of the previous trunk head) and must be synced with this candidate before integration.
Ready for integration: current local D/C/I trunk candidate has a green merge gate; hosted CI is pending because it is not pushed. Track C's full branch is not yet ready for integration.
Requests to other tracks: H installment failure/final-notice push/SMS fanout still needs a shared consent-aware durable delivery contract; K contextual Help links remain an acceptance gap. B, E, F and J current tips are already in trunk; G's scheduler code is in trunk and its current journeys pass.

## Completed Track C work

- Track F restricted-file authorization: verified linked guardians can upload restricted credential and return-to-play evidence; owner/compliance downloads are authorized, every Restricted read is audited, and other readers receive 404.
- Track H chat attachments: active same-organization conversation members can upload and download images/PDF; image metadata is stripped; nonmembers receive 404 and Restricted reads remain audited.
- Chat attachment expiry is checked against the message operation clock, so a file valid at send time is not rejected because a fixed test time predates the machine clock.
- Track I Classes discovery: the family portal shell links to the generated `/me/orgs/:orgId/classes` route in desktop/mobile navigation with English and Spanish labels.
- Track J Federation discovery: Console Home exposes Federation only when the authenticated relationships endpoint succeeds; `/console/federation/:orgId` is linked without granting access from a guessed route. Federation's admin database pool is initialized before the web process scrubs `DATABASE_ADMIN_URL`.
- Fixed duplicate safety-center actions for owners with audit access and scoped the Federation journey's data-sharing controls to its named fieldset.
- Track G schedule discoverability: organization owners can open the nested schedule route from Console Home; public facility pages load layout images through the Files module's approved-public-layout endpoint.
- Track H provider IDs: email, SMS, and push adapters return provider message IDs when supplied; fake adapters return stable IDs. Mailpit SMTP reads `ATHLENTRY_MAILPIT_SMTP_PORT` (default 1025).
- Track F evaluator-photo authorization: sensitive person photos are readable only by an evaluator actively assigned to a session containing that participant, while both the event participant's consent and the person's current consent/photo link remain valid; authorized reads are audited.
- Track B season rollover composition: optional `SeasonRolloverExtras` contributions are collected in registered-module order and passed to the seasons router.
- Track K AI configuration and raw uploads: Vite enables AI only when `AI_PROVIDER=anthropic` and a nonblank `ANTHROPIC_API_KEY` are configured; OpenAPI supports all four Phase 15 raw upload media types when K's route is registered.
- Public sponsor logo OpenAPI: documents the active placement image route with its accepted image MIME types and required surface parameters.
- Existing adapter wiring: raw Stripe webhook ingress and worker registration, finance module and routes, generated registry/OpenAPI and nested route discovery. Stripe remains test-mode only.
- SEC-SSRF-C-001: implemented in the Web Push adapter with provider-host validation, public-address checks for every DNS answer, and a pinned HTTPS agent to prevent DNS rebinding; regression tests reject unsafe hosts/addresses and verify the pinned lookup.
- Trunk CI repair `9b5b430` was reported by the owner as fixing the test and Knip jobs; Track D owns the remaining design-parity CI job.
- Phase 15 remains owned by Track K. C removed merge `63871e0` after the corrected full PostgreSQL gate found two schema failures in migration `8500_phase15_growth.sql`; K must carry and resolve that work on its branch.

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
- Track K root navigation acceptance: aggregate `web/src/console/onboarding/nav.ts` and `web/src/console/help/nav.ts` in `web/src/console/nav.ts`, and `web/src/portal/help/nav.ts` in `web/src/portal/nav.ts`; expose an `Organization setup` link from a new admin's console home/nav. K's `e2e/phase15.spec.ts` asserts those visible links and opens setup from console home. Reproduced on Chromium at `6dbb0e2a`: setup is missing from console Home, and console Help center is missing from nav; the family Help assertion follows the latter. K's Knip run independently reports all three onboarding/help nav contributor files as unused until these imports are aggregated. Preserve `OrgShell` and the existing design tokens.
- Reviewed wiring requests addressed to Track A across the local track worktrees. D's website SSR registration, F's offer checkout adapter, and H installment-alert fanout still depend on their route/service contracts reaching C's checkout. For K, expose contextual Help links from each console area to the matching en/es article and the support or concierge-import form. OpenAPI supports explicit lists of raw binary request/response MIME types; K's four-type request override will apply when its route descriptor is registered.
- SEC-002 follow-up: nonmembers now receive concealed 404s for chat history/conversation/moderation and finance staff/template routes; active members without the required finance role still receive 403.
- Review requests addressed to Track A across all `docs/codex/tracks/*.md` for wiring ownership; gated requests remain listed above until their owner contracts land.

## Requests from SEC

- SEC-002: **implemented** — generated operation permission/resource/scope metadata, foreign-resource fixtures, reviewed role matrix, OpenAPI/registry publication and 404 concealment are in the merged security commits; the SEC completeness checks pass.
- SEC-SSRF-C-001: **implemented** — endpoint validation and pinned public DNS addresses are committed in C; adapter regressions and the enabled synthetic loopback Chromium spec pass.
- SEC-CI-001: **implemented** — CI scans full git history on pull requests and pushes to protected branches without PR comments; its regression spec is enabled and passes.
- SEC-KNIP-C: **implemented** — documented Render backup and operator restore-drill scripts are Knip entry points; the Files upload parser and unconsumed enum exports are private; `@sentry/node` is classified as a dynamic optional runtime dependency. Knip reports no C-owned findings.

## Requests from K

- The K AI UI reads `VITE_AI_ENABLED`, but `vite.config.ts` does not currently derive it. Expose the flag only when `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are both configured; keep it false otherwise so the configured AI feature can appear without making disabled-provider UI/network calls.
- Resolved on current trunk `5cdee29e`: the Phase 15 raw-upload OpenAPI operation has a required binary request body for octet-stream, CSV, ZIP and XLSX; `docs/api/openapi.json` contains all four media types.
- Resolved on current trunk `5cdee29e`: `consoleNav` and `portalNav` aggregate the Phase 15 Help contributors; `consoleNav` includes `onboardingNav`, and console Home exposes the Organization setup action. The remaining K request is contextual Help links from console areas to matching en/es articles and support/concierge-import forms, with the design system unchanged.

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
- Latest observed hosted trunk run: `36489602298`, head `91614aaac689a0c20c1acd26a26631cf60f849dd`; test failures were two chat integration assertions, E2E had Linux parity and WebKit recovery journey failures, OpenAPI output was stale, and Knip found two evaluation nav files. This predates the current D/C/I candidate. Orchestrator must run/publish CI for the new trunk SHA after this local merge is committed.

## Requests from QA

- **QA-QUAL-001 hosted CI follow-up:** run `36640228008` reports `static (knip)` RED on QA head `910e0b0c`, despite the latest C notes reporting a clean local Knip run. The shared CI summary has no itemized findings and QA's sandbox cannot reach GitHub; identify the exact current Knip list and coordinate each remaining code owner before claiming the gate green.
- **QA-ACC-064:** Derive the optional AI client flag from `AI_PROVIDER` and key presence at build time without exposing the key; add configured and disabled state coverage using a fake provider. See `docs/codex/qa/DEFECTS.md`.
- **QA-ACC-065:** Coordinate the public website route contract with A and SSR registration with D; mount `/site` and host-root SEO aliases through the shared app, with tenant-safe verified custom-domain resolution and an integrated smoke journey. See `docs/codex/qa/DEFECTS.md`.

- **QA-ACC-053:** The role crawler still needs complete dynamic detail-route inventory and valid record-derived fixtures for coach/team staff, officials, and volunteers; it currently seeds navigation actors but cannot reach every documented detail route. See `docs/codex/qa/DEFECTS.md`.
- **QA-SEC-001 / QA-SEC-016:** Current `rebuild/trunk` has an empty permission-matrix operation map and no operation permission/resource/scope metadata in the OpenAPI snapshot. The fuzz test also substitutes random IDs, has no same-tenant controls, and covers only GET/PATCH/DELETE. Integrate the generated contracts and reusable valid-resource fixtures for foreign and same-tenant requests across applicable methods; see `docs/codex/qa/DEFECTS.md`.
- **QA-SEC-019:** The permission-matrix test verifies only metadata, row/role completeness, and allow/deny partitioning; it does not exercise route authorization against the matrix predictions. Add safe route-level or policy-harness checks for declared allowed/denied roles and scoped-role boundaries; see `docs/codex/qa/DEFECTS.md`.

- **QA-ACC-050:** Refresh the committed launch-gate evidence against current `rebuild/trunk` `5cdee29e` and hosted CI for the exact promotion candidate. The tracked gate cites another candidate and marks route crawling absent; keep item 10 failed until QA's crawler is integrated and all-role route results are current.
