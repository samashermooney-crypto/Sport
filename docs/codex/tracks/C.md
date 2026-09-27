# Track C — files, adapters, and wiring
Status: working
Branch: `track/c-adapters`
Current: merged the locally available `rebuild/trunk` at `cd5b638` (Federation) into C; trunk then advanced with H's Phase 11 merge `0ca39573`, which still needs to be synced after this merge is committed. Route registry, permission matrix, Kysely types and OpenAPI were regenerated. Full real-Postgres Vitest passes (245 files, 873 tests, 1 existing skip); typecheck/lint and the targeted Federation, safety and tenant-fuzz Chromium journeys pass. The full Chromium run has one remaining platform impersonation/notification failure to diagnose.
Ready for integration: no; sync `0ca39573`, close the platform browser failure, pass the full branch gate and locked trunk merge gate. Track D owns any remaining design-parity CI work. Phase 15 remains owned by Track K.
Requests to other tracks: Track A — no remaining C-owned file/provider implementation request. Track B — compose optional `SeasonRolloverExtras` contributions through the seasons router; its module is not yet in C's checkout, and H owns the volunteer copier contribution. Track D — report/Action Center/website/export modules and nested routes need registry discovery after merge. Track E — regenerate OpenAPI for exact-line refunds/transfer refund results and, after migrations 1052–1053 land, regenerate DB types and record the 10,000-cent late-fee cap; installment failure/final-notice push/SMS fanout awaits H's durable comms worker. Track F — evaluator checkout adapter depends on E; audited consented evaluator-photo reads remain pending. Track G — Console Home schedule and approved facility layout wiring are ready; family schedule navigation needs a same-org member/team selection contract from G/B. Track H — authorize safe public sponsor-logo delivery when the sponsor module lands; attachment authorization and provider IDs are complete. Track I — family Classes navigation is ready. Track J — federation discovery is implemented in Console Home. Track K — raw binary OpenAPI request bodies are implemented; AI config and Help routes need K's modules to merge before runtime wiring.
Requests from OPS: addressed in the current worktree — public `/readyz` and `/status`, web/worker structured startup and redacted Sentry hooks, key scripts, registered periodic heartbeat/queue/Stripe/payment/email alert checks, and removal of the web process's admin URL environment variable after pool initialization.

## Completed Track C work

- Track F restricted-file authorization: verified linked guardians can upload restricted credential and return-to-play evidence; owner/compliance downloads are authorized, every Restricted read is audited, and other readers receive 404.
- Track H chat attachments: active same-organization conversation members can upload and download images/PDF; image metadata is stripped; nonmembers receive 404 and Restricted reads remain audited.
- Track I Classes discovery: the family portal shell links to the generated `/me/orgs/:orgId/classes` route in desktop/mobile navigation with English and Spanish labels.
- Track J Federation discovery: Console Home exposes Federation only when the authenticated relationships endpoint succeeds; `/console/federation/:orgId` is linked without granting access from a guessed route. Federation's admin database pool is initialized before the web process scrubs `DATABASE_ADMIN_URL`.
- Fixed duplicate safety-center actions for owners with audit access and scoped the Federation journey's data-sharing controls to its named fieldset.
- Track G schedule discoverability: organization owners can open the nested schedule route from Console Home; public facility pages load layout images through the Files module's approved-public-layout endpoint.
- Track H provider IDs: email, SMS, and push adapters return provider message IDs when supplied; fake adapters return stable IDs. Mailpit SMTP reads `ATHLENTRY_MAILPIT_SMTP_PORT` (default 1025).
- Existing adapter wiring: raw Stripe webhook ingress and worker registration, finance module and routes, generated registry/OpenAPI and nested route discovery. Stripe remains test-mode only.
- SEC-SSRF-C-001: implemented in the Web Push adapter with provider-host validation, public-address checks for every DNS answer, and a pinned HTTPS agent to prevent DNS rebinding; regression tests reject unsafe hosts/addresses and verify the pinned lookup.
- Trunk CI repair `9b5b430` was reported by the owner as fixing the test and Knip jobs; Track D owns the remaining design-parity CI job.
- Phase 15 remains owned by Track K. C removed merge `63871e0` after the corrected full PostgreSQL gate found two schema failures in migration `8500_phase15_growth.sql`; K must carry and resolve that work on its branch.

## Wiring queue

- SEC-001: **implemented** — security headers are mounted before API/static routes; production security.txt requires configured staffed contact/policy values; Stripe/Turnstile and configured storage origins remain allowed and HSTS stays production-only.
- SEC-002: **implemented** — `a981e0d` and `8290731` generate permission/resource/scope metadata for every API operation, publish it through OpenAPI and the registry, validate metadata at app startup, and supply schema-valid query/path/body fixtures. The owner-aware permission matrix and tenant-fuzz browser tests are enabled and pass.
- SEC-003: **verified** — raw Stripe and Connect ingress is mounted before feature routers; the webhook router consumes raw bytes for signature verification.
- SEC-004: **implemented** — `/.well-known/security.txt` is served, production contact/policy values fail closed until configured, and CI scans full git history with gitleaks without posting PR comments.
- Track B: generated Programs/Teams/Facilities routes are present; shared Files request/result/record/download contracts and `FILE_INVALID` error envelope are implemented in the current worktree. A-owned mutable-org expected-version migration remains with A. Optional `SeasonRolloverExtras` composition remains pending.
- Track E: register and mount registration once its module and route land; regenerate registry/OpenAPI and DB types. Mount checkout UI only after payer-owned IDs and frozen quote contracts exist, linking checkout/invoice before PaymentIntent. Regenerate OpenAPI for new finance routes and binary PDF media types.
- Track OPS: implemented in the current worktree; focused real-Postgres health/metrics and job-registry tests pass.
- Track H: wire `installment.failed` and `installment.final_notice` fanout to consented push/SMS when comms workers and event contracts are available; authorize sponsor logo reads against the active sponsor, placement, contract dates, same-org public `website_asset` and image MIME when those modules are in the C checkout.
- Reviewed wiring requests addressed to Track A across the local track worktrees. D module/route discovery, B rollover contributions, F evaluator access/offer adapter, K's AI/Help runtime wiring and H installment-alert fanout remain gated on those owners' contracts reaching trunk. Raw binary request-body support is committed and generated OpenAPI documents it as `application/octet-stream`.
- SEC-002 follow-up: nonmembers now receive concealed 404s for chat history/conversation/moderation and finance staff/template routes; active members without the required finance role still receive 403.
- Review requests addressed to Track A across all `docs/codex/tracks/*.md` for wiring ownership; gated requests remain listed above until their owner contracts land.

## Requests from SEC

- SEC-002: **implemented** — generated operation permission/resource/scope metadata, foreign-resource fixtures, reviewed role matrix, OpenAPI/registry publication and 404 concealment are in the merged security commits; the SEC completeness checks pass.
- SEC-SSRF-C-001: **implemented** — endpoint validation and pinned public DNS addresses are committed in C; adapter regressions and the enabled synthetic loopback Chromium spec pass.
- SEC-CI-001: **implemented** — CI scans full git history on pull requests and pushes to protected branches without PR comments; its regression spec is enabled and passes.
- SEC-KNIP-C: **implemented** — documented Render backup and operator restore-drill scripts are Knip entry points; the Files upload parser and unconsumed enum exports are private; `@sentry/node` is classified as a dynamic optional runtime dependency. Knip reports no C-owned findings.

## Verification and environment

- Use real PostgreSQL integration tests; do not skip or weaken DB tests. Run full tests and Playwright only through `~/athlentry-sprint/heavy.sh`.
- Latest checks: `npm run typecheck` and `npm run lint` pass. Against the real C Postgres stack, Federation, Files/RLS, app wiring and full Vitest passed (245 files, 873 passed, 1 existing skip). The three C/Federation/safety Chromium regressions pass together; the full 39-test Chromium run had 37 pass, 1 existing skip and one platform impersonation notification request-header failure. Build, Knip, audit, registry/OpenAPI freshness and the post-H-sync gate remain.
- C stack: `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=510` (Postgres `127.0.0.1:5942`), migrations through `6002` applied. Offset 500 is occupied by Track E, so C retains its isolated 510 mapping.
- Full tests and Playwright must continue through `~/athlentry-sprint/heavy.sh`; database and browser coverage is not skipped or weakened.
- GitHub Actions could not be queried because `gh run list` failed to connect to `api.github.com`. The owner last reported test/Knip green and Track D working on design parity; remote CI status remains unverified here.
