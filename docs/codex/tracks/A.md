# Track A — core and integration

Status: working
Model: Codex GPT-6 Luna Extra High
Branch: `track/a-core`
Current: Track A owns Phase 1 remaining tasks 3–8 and 16–17, then Phase 2 to acceptance. The branch adds reversible CSV/XLSX import preview/commit/rollback, import UI coverage, OpenAPI routes and earlier guardian, athlete-link, medical, emergency-contact, household, and merge work. After syncing current trunk at `56ef1aa`, typecheck, full lint, 27 focused PostgreSQL tests (including the 2,000-row timing/rollback case), and five Chromium People/guardian/import tests pass. The full trunk suite caught missing import foreign-key indexes; migration `0903_import_fk_indexes.sql` now adds all five and the schema-spine index contract passes four tests. Phase 1 task 4's native PushManager subscription proof, design parity/localization in task 16, role-aware medical compliance, and remaining Phase 2 acceptance are open. Track C owns wiring and `PROGRESS.md`.
Integrated into `rebuild/trunk` under the self-merge gate. Merged trunk passed typecheck, full lint, 768 tests (one skip), and all 27 desktop Chromium journeys (four guarded security skips). Migration `0903_import_fk_indexes.sql` fixed the schema-spine failure found by the first merge attempt. Phase 1 task 4's native PushManager subscription proof, shell parity/localization in task 16, and remaining Phase 2 acceptance stay open. Track C owns app/worker/router/registry wiring and hourly full gates.
Requests to other tracks: none. Track C continues app/worker/router/registry wiring, hourly full gates, and `PROGRESS.md`.
Requests from OPS: Record DEC-082 in `docs/codex/DECISIONS.md`: encrypted AES-256-GCM logical backups and scratch-only restore verification; a public status response limited to non-sensitive service state; and Sentry event scrubbing for child/family PII (2026-09-27).
Requests from OPS: Implement the documented `load` seed profile (100 organizations, 150k people, 400k registrations, 2M attendance rows) so Phase 16 EXPLAIN/load acceptance can run (2026-09-27).
Blocked on: none

## Requests from SEC

- Regenerate `server/src/db/types.ts` after migration `1054_late_fee_fk_index.sql`; applying current migrations added `invoice_lines.late_fee_installment_id`, which is absent from the checked-in generated types (2026-09-27).
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. Track C's SMTP port offset passes isolated browser tests.
Self-review: The Phase 1 tenancy matrix is derived from the documented Phase 1 OpenAPI routes, tests 32 organization paths and four account query aliases against a real second tenant, and verifies direct RLS isolation through `withOrg`.
Self-review: Account language updates require an authenticated session and verified write origin; the account page follows and saves the durable locale used by SMS consent, with Chromium/WebKit and database evidence.
Self-review: The platform area now shares the frozen AppShell and exposes only working Platform and Account links; its existing Chromium/WebKit operations journey remains accessible.
Self-review: People reads and writes run inside `withOrg`, require an active staff role except audited platform impersonation reads, reject impersonation writes, use versions for edits/archive/restore, and leave an audit trail. Remaining Phase 2 task 1 filters and media flows are tracked in PROGRESS.
