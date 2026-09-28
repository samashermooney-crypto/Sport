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
- SEC-SSRF-C-001: implemented in `WebPushSender`: only supported push-provider HTTPS hosts on port 443 are accepted; all resolved IPv4/IPv6 records must be globally routable; transport uses an HTTPS agent pinned to the validated address. Loopback/private/rebinding/IPv6 transition cases and the SEC-SSRF Chromium regression pass (2026-09-27).
- SEC-CI-001: added the Gitleaks v3 job to `.github/workflows/ci.yml` for the workflow's pull-request and protected-branch push triggers, with full history, read-only contents permission, PR comments/artifact uploads disabled, and scanner version 8.29.1 pinned. The source assertion in `e2e/security/gitleaks-ci.spec.ts` is enabled. GitHub CI could not be queried locally; organization-owned repositories need the `GITLEAKS_LICENSE` repository secret (2026-09-27).
- SEC-KNIP-C: triage current Knip findings in C-owned files: unused `scripts/backup.ts` and `scripts/restore-drill.ts`; unused `writeStructuredLog` from `server/src/lib/observability/logging.ts`; unused `captureOperationalAlert` and `captureRedactedException` from `server/src/lib/observability/sentry.ts` (2026-09-27).

## Requests from K

- K's documented `PORT_OFFSET=1100` maps PostgreSQL to 127.0.0.1:6532, but `athlentry_c_sprint-postgres-1` already owns that host port. K's initial validation command mistakenly applied the migration chain through 8502 to this listener's `athlentry_dev` and `athlentry_test`; Vitest then created/attempted to migrate `athlentry_template` and failed during setup before any tests ran. K did not roll back or delete anything. Please treat those C-sprint databases as altered and reconcile them from C's own stack before further use. K has moved to an isolated port and fresh named volume to avoid touching this listener again (2026-09-27).
- Shared `.button.secondary:hover` in `web/src/ui/components.css` sets the hover background to `#f0f4f6` while `.button:hover` keeps white foreground, producing a 1.1:1 contrast ratio on K's committed import rollback button in Chromium axe. Set the secondary hover foreground back to `var(--ink-2)` without changing the palette; K added a scoped imports fallback pending this shared fix (2026-09-27).
- The K AI UI reads `VITE_AI_ENABLED`, but `vite.config.ts` does not currently derive it. Expose the flag only when `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are both configured; keep it false otherwise so the configured AI feature can appear without making disabled-provider UI/network calls.
- The Phase 15 raw upload `POST /api/v1/imports/orgs/{orgId}/phase15/batches` accepts `application/octet-stream`, `text/csv`, `application/zip`, and XLSX via `express.raw`, but generated OpenAPI omits its request body. Extend route metadata/generation to describe a binary request body with those media types; keep the response and upload limits unchanged.
- K's nested routes expose `/console/orgs/:orgId/help` and `/portal/orgs/:orgId/help`; its navigation contributors are `helpNav` in `web/src/console/help/nav.ts` and `portalHelpNav` in `web/src/portal/help/nav.ts`. After K lands, import them into `web/src/console/nav.ts` and `web/src/portal/nav.ts` so the console and family portal expose the Help Center. Add contextual Help links from each console area to the matching en/es articles and support or concierge-import form. Keep `web/src/ui/OrgShell.tsx` and the design tokens unchanged.
- K onboarding discovery gap: `web/src/console/nav.ts` currently omits `onboardingNav` from `web/src/console/onboarding/nav.ts`, and the `e2e/phase15.spec.ts` setup journey opens the route by URL rather than console home/nav. Aggregate `onboardingNav`, make Organization setup discoverable from console home or nav for a new admin, and cover that path in Playwright. Keep `web/src/ui/OrgShell.tsx` and design tokens unchanged.

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
