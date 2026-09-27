# Track A — core and integration

Status: working
Model: Codex GPT-6 Luna Extra High
Branch: `track/a-core`
Current: Track A owns Phase 1 remaining tasks 3–8 and 16–17, then Phase 2 to acceptance. The branch adds reversible CSV/XLSX import preview/commit/rollback, import UI coverage, OpenAPI routes and earlier guardian, athlete-link, medical, emergency-contact, household, and merge work. After syncing current trunk at `56ef1aa`, typecheck, full lint, 27 focused PostgreSQL tests (including the 2,000-row timing/rollback case), and five Chromium People/guardian/import tests pass. The full trunk suite caught missing import foreign-key indexes; migration `0903_import_fk_indexes.sql` now adds all five and the schema-spine index contract passes four tests. Phase 1 task 4's native PushManager subscription proof, design parity/localization in task 16, role-aware medical compliance, and remaining Phase 2 acceptance are open. Track C owns wiring and `PROGRESS.md`.
Integrated into `rebuild/trunk` under the self-merge gate. Merged trunk passed typecheck, full lint, 768 tests (one skip), and all 27 desktop Chromium journeys (four guarded security skips). Migration `0903_import_fk_indexes.sql` fixed the schema-spine failure found by the first merge attempt. Phase 1 task 4's native PushManager subscription proof, shell parity/localization in task 16, and remaining Phase 2 acceptance stay open. Track C owns app/worker/router/registry wiring and hourly full gates.
Requests to other tracks: none. Track C continues app/worker/router/registry wiring, hourly full gates, and `PROGRESS.md`.
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

## HANDOFF

The owner's direct engine-switch instruction in this session supersedes the current `SPRINT.md` text that says engine switches are finished. Track A worktree: `/Users/sammooney/Sport`, branch `track/a-core`.

### Done

- The people, household, medical, emergency-contact, merge, and import work through commit `2ac58d6` is already on `rebuild/trunk`. Its merge gate passed typecheck, lint, 768 tests (one skipped), and 27 desktop Chromium tests (four guarded security skips).
- Initial forms and waivers backend work is checkpointed in commit `9df6ebd`: shared schemas, service and route modules, migration `0904_immutable_form_and_waiver_versions.sql`, and a forms integration test.
- The `9df6ebd` commit hooks passed ESLint, Prettier, and `npm run typecheck`.

### In progress

These files are committed on `track/a-core` but have not passed the sprint merge gate:

- `db/migrations/0904_immutable_form_and_waiver_versions.sql` — immutable published versions and append-only signatures; not yet applied to the local database.
- `shared/src/schemas/forms.ts`
- `shared/src/schemas/waivers.ts`
- `server/src/modules/forms/service.ts`
- `server/src/modules/forms/routes.ts`
- `server/src/modules/forms/module.ts`
- `server/src/modules/waivers/service.ts`
- `server/src/modules/waivers/routes.ts`
- `server/src/modules/waivers/module.ts`
- `server/test/forms.test.ts` — not yet run against PostgreSQL.

There is no waiver integration test or Forms/Waivers UI yet. The new module definitions are not registered in the generated module/feature registries, so these routes are not yet reachable through the app.

### Next steps, in order

1. Read the current `docs/codex/PROGRESS.md` and the Phase 1 and Phase 2 specs; Track C owns `PROGRESS.md` updates.
2. Start Track A's isolated PostgreSQL stack (`COMPOSE_PROJECT_NAME=athlentry_a`, `PORT_OFFSET=3000`), apply migration 0904, and run the forms test. Add `server/test/waivers.test.ts` and cover document version immutability, signer authorization (including both required signers), append-only evidence, and PDF signer/text/hash/timestamp evidence.
3. Fix any database-test failures and finish forms/waivers authorization and conditional-answer coverage, including encrypted restricted answers, historical rendering, and profile-answer reuse rules.
4. Build the Forms and Waivers screens with the frozen design tokens and working end-to-end actions. Record a request for Track C to register the modules and regenerate route/OpenAPI artifacts; do not edit C-owned app, worker, registry, generated, or `PROGRESS.md` files.
5. Finish Phase 1 remaining tasks 3–8 and 16–17. Task 4 still needs browser PushManager subscription proof; the prior Playwright attempt failed at `PushManager.subscribe()` with `Registration failed - permission denied`. Continue the remaining Phase 1 shell/localization and acceptance work from the current specs.
6. Finish every open Phase 2 criterion in the current ledger, including the two-child household mobile journey, role-aware people/compliance filters, media flows, and forms/waivers acceptance.
7. At the next merge boundary, use the `rebuild/trunk` lock protocol from `SPRINT.md`, run the full merge gate through `~/athlentry-sprint/heavy.sh`, and merge only if it passes. Do not merge `9df6ebd` by itself: only commit-hook checks have run on it.

### Test status and known failures

- Passed on the current WIP commit: ESLint, Prettier, and TypeScript project typecheck from the commit hook.
- Not run on the current WIP commit: database migration, focused forms/waivers integration tests, full Vitest suite, Playwright, and build.
- No failing test has been confirmed in the current WIP. The browser PushManager permission failure above is a known open acceptance item, not a committed failing spec.
- The previous trunk merge gate at `2ac58d6` passed as recorded above. The current `rebuild/trunk` worktree is at `2ac58d6`; no merge was attempted for the ungated WIP commit.

### Open request to Track C

- After the Forms/Waivers routes are ready, register both modules, discover their feature routes, regenerate the OpenAPI and registry outputs, and refresh generated database types if required by the applied migrations.

### Local test environment

- `COMPOSE_PROJECT_NAME=athlentry_a`
- `PORT_OFFSET=3000` (local database port `8432`)

HANDED OFF 12:29
