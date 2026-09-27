# Track A — core and integration

Status: handoff
Model: Devin CLI SWE-2 Max (owner-directed engine switch)
Branch: `track/a-core`
Current: Track A owns Phase 1 remaining tasks 4 and 16, then Phase 2 to acceptance. The branch includes the `rebuild/trunk` merge at `5ae5499` and latest Track A commit `6d738db`; the new Forms/Waivers services and schemas include encrypted tiered form responses with audited restricted reads, versioned waiver evidence, merge-safe preservation of append-only signatures, and a published-form list for verified linked people. Focused PostgreSQL forms, waiver, and merge tests pass; typecheck and lint pass. Phase 1 task 4's browser PushManager proof and task 16's public shell and actual-screen parity remain open. Phase 2 role-aware compliance, athlete self claims, family editing, forms/waivers UI, and the complete two-child household journey remain open. Track C owns generated route/module wiring and `PROGRESS.md`.
Track A's people, household, guardian invitation, medical, photo, merge, and import slices are already integrated on trunk. The import contract remains mapping-driven and shared with later phases.
Requests to other tracks: Track C should register the forms and waivers modules, expose their feature routes, and regenerate OpenAPI/registry artifacts after the routes are acceptance-ready. Track C continues app/worker/router/registry wiring, hourly full gates, and `PROGRESS.md`.
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

### Done

- Track A people, household, guardian invitation, medical, photo, merge, and import slices are already on `rebuild/trunk`.
- On `track/a-core`, added form/waiver services and schemas, tiered response encryption, audited restricted reads, append-only signed waiver evidence, and merge-lineage reads. Commit `0b096a7` contains the service and evidence work.
- Commit `6d738db` adds `GET /api/v1/forms/orgs/{orgId}/person`, restricted to an active verified person link and returning only published, non-retired `person_profile` forms. The route is in `server/src/modules/forms/routes.ts` and the module's API contract is in `server/src/modules/forms/module.ts`.
- Verified `npm run typecheck`, `npm run lint`, and `COMPOSE_PROJECT_NAME=athlentry_a PORT_OFFSET=3000 DATABASE_ADMIN_URL=postgres://athlentry_admin@127.0.0.1:8432/athlentry_test DATABASE_APP_URL=postgres://athlentry_app@127.0.0.1:8432/athlentry_test npm test -- --project=server server/test/forms.test.ts --hookTimeout=60000 --testTimeout=30000` (1 test passed). Commit hooks also passed typecheck.

### In progress and exact paths

- Phase 1 task 4 browser PushManager proof: `web/src/auth/BrowserPush.tsx`, `e2e/sign-in.spec.ts`. The previous browser subscription attempt failed with `Registration failed - permission denied`; device-token API coverage exists.
- Phase 1 task 16 public/platform shell, full locale copy, and screen parity: `web/src/app.tsx`, `web/src/ui/shell.tsx`, `web/src/ui/PlatformShell.tsx`, `web/src/ui/tokens.css`, `web/src/lib/i18n.ts`, `web/src/i18n/en/platform.json`, `web/src/i18n/es/platform.json`, `web/src/platform/PlatformConsole.tsx`, and `e2e/design/parity.spec.ts`. The public-site reference images are under `e2e/visual-reference/`; public shell and complete parity remain open.
- Phase 2 task 1 role-aware compliance and task 3 athlete self links/adult self claims: `server/src/modules/people/routes.ts`, `server/src/modules/people/medical.ts`, `server/src/modules/people/selfClaims.ts`, `web/src/people/PeopleConsole.tsx`, `web/src/people/AthleteAccess.tsx`, `web/src/people/PersonClaim.tsx`, and `web/src/people/AcceptPersonClaim.tsx`.
- Phase 2 task 9 family profile/medical/emergency/photo/document editing and athlete read-only view: `server/src/modules/people/family.ts`, `server/src/modules/people/medical.ts`, `web/src/people/FamilyHome.tsx`, `web/src/people/FamilyMedical.tsx`, `web/src/people/EmergencyContacts.tsx`, `web/src/people/PersonPhoto.tsx`, and `web/src/people/AthleteAccess.tsx`.
- Forms/waivers UI and the two-child 390 px guardian medical journey: `web/src/people/routes.tsx`, `web/src/people/nav.ts`, `e2e/guardian-invitation.spec.ts`, `server/test/forms.test.ts`, and `server/test/waivers.test.ts`. The server feature modules are `server/src/modules/forms/{module.ts,routes.ts,service.ts}` and `server/src/modules/waivers/{module.ts,routes.ts,service.ts}`. Review `requires: 'both'` in `server/src/modules/waivers/service.ts` against the waiver specification before treating it as complete.
- Phase 2 large import acceptance: `server/src/modules/imports/{repo.ts,routes.ts}`, `server/test/imports.test.ts`, and `e2e/people-import.spec.ts`.

### Next steps, in order

1. Finish Phase 1 task 4 browser proof and task 16 public/platform shell and visual parity; keep Phase 1 open until all acceptance criteria pass.
2. Finish Phase 2 role-aware compliance, adult/athlete self claims, and family editing/read-only access. Complete the 2,000-row import performance/rollback evidence and merge-conflict acceptance.
3. Finish Forms/Waivers screens and historical-response/signed-PDF acceptance, then extend `e2e/guardian-invitation.spec.ts` for two children, guardian invitation, medical entry at 390 px, and axe.
4. Ask Track C through the existing integration workflow to mount the forms and waivers modules and feature routes, then regenerate OpenAPI/registry artifacts; Track C also owns `PROGRESS.md` and the full gate.
5. Run the complete gate and browser suite through `~/athlentry-sprint/heavy.sh`. Merge this branch into `rebuild/trunk` only after its merge gate passes, using `/tmp/athlentry-trunk.lock`; abort the merge if the gate is red.

### Known failing tests and gate status

- No known failing tests in the code paths verified above. An earlier unscoped test invocation selected no matching project and tried the default PostgreSQL port 5432; the correctly scoped server test passed against port 8432.
- Full `npm test`, Playwright, build, generated-file freshness, and the trunk merge gate have not run for the current branch state. This branch has not been merged to trunk.

### Open requests

- Track C: mount `forms` and `waivers` in its generated module/feature-route wiring and regenerate OpenAPI/registry after the routes are ready. Track C owns `server/src/app.ts`, worker wiring, registries, and `docs/codex/PROGRESS.md`.
- SEC: regenerate `server/src/db/types.ts` after migration `1054_late_fee_fk_index.sql`; the existing note above records that `invoice_lines.late_fee_installment_id` was missing from generated types.

### Isolated test stack

- `COMPOSE_PROJECT_NAME=athlentry_a`
- `PORT_OFFSET=3000` (Postgres port `8432`)
