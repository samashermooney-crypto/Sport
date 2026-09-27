# Track C — files, adapters, and wiring
Status: working
Branch: `track/c-adapters`
Current: merged the locally available `rebuild/trunk` at `af353fc`; Track C is resuming the trunk gates and wiring queue. Phase 15 remains owned by Track K.
Ready for integration: no; trunk merge and current wiring changes need the required gates.
Requests to other tracks: Track A — reconcile DEC-023 with verified-guardian restricted uploads and owner/compliance-only restricted downloads. Track E — registration module/route and checkout contracts are prerequisites for registration UI wiring.
Blocked on: GitHub access is currently unavailable from this environment; local gates remain available.

## Completed Track C work

- Track F restricted-file authorization: verified linked guardians can upload restricted credential and return-to-play evidence; owner/compliance downloads are authorized, every Restricted read is audited, and other readers receive 404.
- Track H chat attachments: active same-organization conversation members can upload and download images/PDF; image metadata is stripped; nonmembers receive 404 and Restricted reads remain audited.
- Track H provider IDs: email, SMS, and push adapters return provider message IDs when supplied; fake adapters return stable IDs. Mailpit SMTP reads `ATHLENTRY_MAILPIT_SMTP_PORT` (default 1025).
- Existing adapter wiring: raw Stripe webhook ingress and worker registration, finance module and routes, generated registry/OpenAPI and nested route discovery. Stripe remains test-mode only.
- Trunk CI repair `9b5b430` was reported by the owner as fixing the test and Knip jobs; Track D owns the remaining design-parity CI job.
- Track K's Phase 15 merge `63871e0` is present in this branch, but C will not finish or claim Phase 15 acceptance.

## Wiring queue

- SEC-001: **implemented** — security headers are mounted before API/static routes; production security.txt requires configured staffed contact/policy values; Stripe/Turnstile and configured storage origins remain allowed and HSTS stays production-only.
- SEC-002: add generated permission/resource/scope metadata to API operations and expose it to OpenAPI and route tests. ID-bearing org-scoped reads/writes need tenancy-fuzzer fixtures; mutations need schema-valid synthetic bodies.
- SEC-003: verify raw Stripe and Connect webhook routers mount before JSON parsing.
- SEC-004: `/.well-known/security.txt` is served; production contact/policy values are deployment-configured and fail closed until staffed values are supplied. Add gitleaks to CI.
- Track B: mount Programs, Teams, and Facilities route arrays and navigation when their module paths land; move file and B module contracts to shared Zod, use version helpers for mutable org routes, and align `FILE_INVALID` with the shared error envelope.
- Track E: register and mount registration once its module and route land; regenerate registry/OpenAPI and DB types. Mount checkout UI only after payer-owned IDs and frozen quote contracts exist, linking checkout/invoice before PaymentIntent. Regenerate OpenAPI for new finance routes and binary PDF media types.
- Track OPS: wire `/readyz` and public `/status`; initialize structured logger/Sentry in web and worker; add key-generation scripts and health/queue/payment/email alert checks; remove `DATABASE_ADMIN_URL` from web runtime after pre-deploy.
- Track H: wire `installment.failed` and `installment.final_notice` fanout to consented push/SMS when comms workers and event contracts are available.
- Review requests addressed to Track A across all `docs/codex/tracks/*.md` for wiring ownership and record completion here.

## Verification and environment

- Use real PostgreSQL integration tests; do not skip or weaken DB tests. Run full tests and Playwright only through `~/athlentry-sprint/heavy.sh`.
- C stack uses `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=510` (Postgres `127.0.0.1:5942`). The stack was moved from offset 900, preserving its volume; trunk's full migrations and K's `8500_phase15_growth.sql` were applied and Kysely types regenerated.
- Focused verification: app wiring, Files/RLS, chat attachment and security-header suites passed (4 files, 24 tests) against real PostgreSQL; typecheck, lint, registry, OpenAPI and Knip pass after the header mount. Full tests, E2E and other sprint gates remain open.
- At the last check, local trunk was `af353fc`, seven commits ahead of its remote; GitHub DNS/network access failed. The lock `/tmp/athlentry-trunk.lock` was absent.
- K's targeted onboarding/AI/help Postgres suite passed 12/12; a previous pre-K C test gate passed 726 tests and one existing skip. Full verification after K and the current trunk merge remains outstanding.
