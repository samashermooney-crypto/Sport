# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Spine, ready B/C/D/E/F/H ranges, Phase 1 tasks 5–9, 11–13 and 17, Track F's safety foundation and the first Phase 2 people CRUD/search slice are integrated on `rebuild/trunk`. Task 16 has bilingual family/platform shells and durable account locale; design parity and public shell remain. Task 4 remains open after Chromium native push subscription returned permission denied despite an activated service worker and granted permission. Track E has since marked all prerequisite finance work ready; its aid/credit/tax/year-end/autopay/PDF/notice ranges through migration 1035 are staged on A. Five payer finance pages are mounted and a Chromium/WebKit invoices-to-receipts journey passes. The local full gate passed 668 tests and 36 browser tests plus typecheck, lint, build, size and generated-file freshness; trunk integration follows.
Ready for integration: the People household/balance filter slice on A passed its local gate: typecheck, lint, 684 tests (one operator smoke skipped), 36 browser tests (four guarded design skips), build, size and generated-file freshness. PostgreSQL covers direct invoice-line debt and removed household membership; Chromium/WebKit covers the staff filter journey. Program/team/compliance and consent-aware media filters remain open.
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
