# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Spine, ready B/C/D/E/F/H ranges, task 6 onboarding, E finance and checkout core through scoped discount-code reservations, and Track B's platform/notification plus E/F/H support ranges and Track C's Restricted-file/provider receipt range are integrated on `rebuild/trunk`. Phase 1 tasks 5–9, 11–13 and 17 are complete. Task 16 includes the tenant-scoped switcher, bilingual family and platform shells, durable account locale, notification controls and Chromium/WebKit journeys. Protected direct entry now synchronizes the saved account language even with a stale browser preference. Its design parity and public shell acceptance remain. Task 4 remains open after a headed Chromium native push subscription returned permission denied despite an activated service worker and granted notification permission. Track F's Phase 7 foundation is integrated with 46 OpenAPI operations, mounted lazy safety routes, and a green 631-test/32-browser trunk gate. Detailed response contracts and Phase 7 acceptance remain open. Track E's newly ready year-end/autopay commits could not be selected without intervening unready finance changes; the cherry-pick was aborted cleanly.
Ready for integration: Phase 2 people CRUD/search slice; local gate passed typecheck, lint, 632 tests (one operator smoke skipped), 34 browser tests (four guarded design skips), build, size, registry and OpenAPI freshness. The safety foundation is already integrated and trunk green.
Requests to other tracks: E — proceed with Phase 4 against the spine now on trunk.
Requests to other tracks: D — identity screens in task 3 are stable for your auth restyle queue; console Home in task 17 remains with A.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. Track C's SMTP port offset passes isolated browser tests.
Self-review: The Phase 1 tenancy matrix is derived from the documented Phase 1 OpenAPI routes, tests 32 organization paths and four account query aliases against a real second tenant, and verifies direct RLS isolation through `withOrg`.
Self-review: Account language updates require an authenticated session and verified write origin; the account page follows and saves the durable locale used by SMS consent, with Chromium/WebKit and database evidence.
Self-review: The platform area now shares the frozen AppShell and exposes only working Platform and Account links; its existing Chromium/WebKit operations journey remains accessible.
Self-review: People reads and writes run inside `withOrg`, require an active staff role except audited platform impersonation reads, reject impersonation writes, use versions for edits/archive/restore, and leave an audit trail. Remaining Phase 2 task 1 filters and media flows are tracked in PROGRESS.
