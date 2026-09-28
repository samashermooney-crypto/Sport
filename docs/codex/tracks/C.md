# Track C — files, adapters, and wiring
Status: working
Branch: `track/c-adapters`
Current: merged the locally available `rebuild/trunk` at `af353fc`; Track C is resuming the trunk gates and wiring queue. Phase 15 remains owned by Track K.
TRUNK GREEN 9381acd1d7eddb5d286e882ccd8e1b7f6200c32c — combined local trunk repair passed the full gate; not pushed.
Ready for integration: no; trunk merge and current wiring changes need the required gates.
Requests to other tracks: Track A — reconcile DEC-023 with verified-guardian restricted uploads and owner/compliance-only restricted downloads. Track E — registration module/route and checkout contracts are prerequisites for registration UI wiring.
## Done by OPS
- Added app-level `/readyz` and public `/status`, sanitized Express error reporting, structured API/worker startup logs, the `@sentry/node` PII-scrubbed hooks, heartbeat/queue/webhook/payment/email alert collection, key-generation/rotation plus backup/restore/replay npm commands, and web startup removal of the pre-deploy database admin variable (2026-09-27).
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
- SEC-002: add generated permission/resource/scope metadata to API operations and expose it to OpenAPI and route tests. ID-bearing org-scoped reads/writes need tenancy-fuzzer fixtures; mutations need schema-valid synthetic bodies.
- SEC-003: **verified** — raw Stripe and Connect ingress is mounted before feature routers; the webhook router consumes raw bytes for signature verification.
- SEC-004: `/.well-known/security.txt` is served; production contact/policy values are deployment-configured and fail closed until staffed values are supplied. Add gitleaks to CI.
- Track B: mount Programs, Teams, and Facilities route arrays and navigation when their module paths land; move file and B module contracts to shared Zod, use version helpers for mutable org routes, and align `FILE_INVALID` with the shared error envelope.
- Track E: register and mount registration once its module and route land; regenerate registry/OpenAPI and DB types. Mount checkout UI only after payer-owned IDs and frozen quote contracts exist, linking checkout/invoice before PaymentIntent. Regenerate OpenAPI for new finance routes and binary PDF media types.
- Track OPS: **done** — health routes, Sentry/logging startup and alert collection, operator npm scripts. Keep `DATABASE_ADMIN_URL` out of web runtime after pre-deploy.
- Track H: wire `installment.failed` and `installment.final_notice` fanout to consented push/SMS when comms workers and event contracts are available.
- Review requests addressed to Track A across all `docs/codex/tracks/*.md` for wiring ownership and record completion here.

## Requests from SEC

- SEC-002: publish generated `permission`, `resource`, and `scope` metadata for every API operation to OpenAPI and the route registry. For ID-bearing organization-scoped GET/PATCH/DELETE operations, include real synthetic foreign-resource path IDs plus schema-valid mutation bodies so the fuzzer tests existing out-of-tenant resources, not random missing IDs. Fill the reviewed role-by-operation allow/deny matrix; keep the three SEC completeness checks skipped until these descriptors and fixtures exist (2026-09-27).
- SEC-SSRF-C-001: validate Web Push subscription endpoints before the `web-push` transport call. `WebPushSender` currently forwards a user-controlled HTTPS URL such as `https://127.0.0.1/...`; reject private/loopback/link-local and unknown destinations before transport and protect DNS resolution from rebinding. Regression assertion is `test.fixme` in `e2e/security/ssrf.spec.ts` (2026-09-27).
- SEC-CI-001: add Gitleaks secret scanning to CI on pull requests and protected-branch pushes; no Gitleaks job is present in `.github/workflows/ci.yml`; `e2e/security/gitleaks-ci.spec.ts` is committed as `test.fixme` (2026-09-27).
- SEC-KNIP-C: triage current Knip findings in C-owned files: unused `scripts/backup.ts` and `scripts/restore-drill.ts`; unused `writeStructuredLog` from `server/src/lib/observability/logging.ts`; unused `captureOperationalAlert` and `captureRedactedException` from `server/src/lib/observability/sentry.ts` (2026-09-27).

## Requests from K

- Shared `.button.secondary:hover` in `web/src/ui/components.css` sets the hover background to `#f0f4f6` while `.button:hover` keeps white foreground, producing a 1.1:1 contrast ratio on K's committed import rollback button in Chromium axe. Set the secondary hover foreground back to `var(--ink-2)` without changing the palette; K added a scoped imports fallback pending this shared fix (2026-09-27).

## Verification and environment

- Use real PostgreSQL integration tests; do not skip or weaken DB tests. Run full tests and Playwright only through `~/athlentry-sprint/heavy.sh`.
- C stack uses `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=510` (Postgres `127.0.0.1:5942`). It was moved from offset 900, preserving its volume; after the K revert, the disposable test/template databases were recreated with the `db/init/001-roles.sql` app defaults and migrations through `4006` were applied. Kysely types were regenerated.
- Focused verification: app wiring, Files/RLS, chat attachment and security-header suites passed (4 files, 24 tests) against real PostgreSQL. Full Vitest passes (203 files, 1 skipped; 745 tests, 1 skipped); Chromium desktop passes (24 passed, 4 pre-existing SEC-002 fixmes skipped); typecheck, lint, build, Knip, registry and OpenAPI generation pass.
- At the last check, local trunk was `af353fc`, seven commits ahead of its remote; GitHub DNS/network access failed. The lock `/tmp/athlentry-trunk.lock` was absent.
- The corrected full C run with K's migration present had only two schema failures: missing FK indexes in migration `8500_phase15_growth.sql` and `mapping_presets.org_id` nullability. C reverted that merge and left Phase 15 with K; the post-revert full Vitest suite passed.

## Final launch gate — 2026-09-27

- Gate code snapshot: `da7c13f40717352ff6b550b7b5026dd6d1e62f94` on local `rebuild/trunk`. Typecheck, lint, full Vitest (246 files; 879 passed, 1 skipped), Playwright Chromium/WebKit (74 passed, 16 skipped), build, size, Knip, audit, OpenAPI and registry freshness passed locally. See [`../LAUNCH-GATE.md`](../LAUNCH-GATE.md) for each Phase 16 §7 item and evidence.
- Promotion: **not ready**. Coverage thresholds, load acceptance, current-head restore proof, security acceptance, Lighthouse and all-route crawler are still failing or absent; GitHub CI status could not be checked without network. Local `main` is unchanged at `d0f59a1c44e499dc69455ed3ad3e0a2dae9883de`; no `MAIN READY` marker is recorded.
- Remaining work: close all failures in `LAUNCH-GATE.md`, update phase acceptance evidence, rerun the full gate, and only then consider promoting local `main`.
