# Track C — files, adapters, and wiring
Status: working
Branch: `track/c-adapters`
Current: trunk test/Knip repair `9b5b430` is reported green; Track D owns the remaining design-parity job. SEC-002 metadata and nonmember-concealment commits are `a981e0d` and `5b64492`; all four security browser checks now pass. Full WebKit/build and trunk gates remain in progress. Phase 15 remains owned by Track K.
Ready for integration: no; finish the branch and trunk gates before integration.
Requests to other tracks: Track A — reconcile DEC-023 with verified-guardian restricted uploads and owner/compliance-only restricted downloads. Track E — registration module/route and checkout contracts are prerequisites for registration UI wiring.
Blocked on: GitHub access is currently unavailable from this environment; local gates remain available.

## Completed Track C work

- Track F restricted-file authorization: verified linked guardians can upload restricted credential and return-to-play evidence; owner/compliance downloads are authorized, every Restricted read is audited, and other readers receive 404.
- Track H chat attachments: active same-organization conversation members can upload and download images/PDF; image metadata is stripped; nonmembers receive 404 and Restricted reads remain audited.
- Track H provider IDs: email, SMS, and push adapters return provider message IDs when supplied; fake adapters return stable IDs. Mailpit SMTP reads `ATHLENTRY_MAILPIT_SMTP_PORT` (default 1025).
- Existing adapter wiring: raw Stripe webhook ingress and worker registration, finance module and routes, generated registry/OpenAPI and nested route discovery. Stripe remains test-mode only.
- Trunk CI repair `9b5b430` was reported by the owner as fixing the test and Knip jobs; Track D owns the remaining design-parity CI job.
- Phase 15 remains owned by Track K. C removed merge `63871e0` after the corrected full PostgreSQL gate found two schema failures in migration `8500_phase15_growth.sql`; K must carry and resolve that work on its branch.

## Wiring queue

- SEC-001: **implemented** — security headers are mounted before API/static routes; production security.txt requires configured staffed contact/policy values; Stripe/Turnstile and configured storage origins remain allowed and HSTS stays production-only.
- SEC-002: **in progress** — `a981e0d` generates permission/resource/scope metadata for every API operation, publishes it through OpenAPI and the registry, and supplies schema-valid query/path/body fixtures. The owner-aware permission matrix and tenant-fuzz browser tests are enabled and pass; full browser/build gates remain open.
- SEC-003: **verified** — raw Stripe and Connect ingress is mounted before feature routers; the webhook router consumes raw bytes for signature verification.
- SEC-004: **implemented** — `/.well-known/security.txt` is served, production contact/policy values fail closed until configured, and CI scans full git history with gitleaks without posting PR comments.
- Track B: mount Programs, Teams, and Facilities route arrays and navigation when their module paths land; move file and B module contracts to shared Zod, use version helpers for mutable org routes, and align `FILE_INVALID` with the shared error envelope.
- Track E: register and mount registration once its module and route land; regenerate registry/OpenAPI and DB types. Mount checkout UI only after payer-owned IDs and frozen quote contracts exist, linking checkout/invoice before PaymentIntent. Regenerate OpenAPI for new finance routes and binary PDF media types.
- Track OPS: wire `/readyz` and public `/status`; initialize structured logger/Sentry in web and worker; add key-generation scripts and health/queue/payment/email alert checks; remove `DATABASE_ADMIN_URL` from web runtime after pre-deploy.
- Track H: wire `installment.failed` and `installment.final_notice` fanout to consented push/SMS when comms workers and event contracts are available.
- Review requests addressed to Track A across all `docs/codex/tracks/*.md` for wiring ownership and record completion here.
- SEC-002 follow-up: nonmembers now receive concealed 404s for chat history/conversation/moderation and finance staff/template routes; active members without the required finance role still receive 403.

## Verification and environment

- Use real PostgreSQL integration tests; do not skip or weaken DB tests. Run full tests and Playwright only through `~/athlentry-sprint/heavy.sh`.
- C stack uses `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=510` (Postgres `127.0.0.1:5942`). It was moved from offset 900, preserving its volume; after the K revert, the disposable test/template databases were recreated with the `db/init/001-roles.sql` app defaults and migrations through `4006` were applied. Kysely types were regenerated.
- Focused verification: the three SEC-001/002 Chromium checks pass (headers, route metadata, tenant fuzzer); chat and finance real-Postgres integration suites pass (2 files, 15 tests). Typecheck, lint, OpenAPI and registry generation pass after `a981e0d`; full branch/trunk gates are pending.
- Local trunk is now `27c2826`, 27 commits ahead of its remote; GitHub DNS/network access previously failed. The trunk lock is released.
- The corrected full C run with K's migration present had only two schema failures: missing FK indexes in migration `8500_phase15_growth.sql` and `mapping_presets.org_id` nullability. C reverted that merge and left Phase 15 with K; the post-revert full Vitest suite passed.
