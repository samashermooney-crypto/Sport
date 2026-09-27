# Track A — core and integration

Status: working
Model: Codex GPT-6 Luna Extra High
Branch: `track/a-core`
Current: Track A owns Phase 1 remaining tasks 3–8 and 16–17, then Phase 2 to acceptance. People, household, age/grade, identity, medical, and retained emergency-contact work is already on `rebuild/trunk`. The current branch slice fixes imports/guardian WIP `47adf1a` and adds the first import console test; typecheck, lint, focused PostgreSQL tests, and the import console component test pass. Phase 1 task 4 and design parity/localization in task 16, role-aware medical compliance, and the remaining Phase 2 acceptance are open. Track C owns wiring and `PROGRESS.md`.
Ready for self-merge: none yet. The import slice needs a Chromium journey and the current-trunk branch gate before merge. Track C owns app/worker/router/registry/OpenAPI wiring and hourly full gates.
Requests to other tracks: C — the trunk full suite repeatedly hit Vitest's default 10-second hook timeout across orgs, platform, communications, chat, compliance and audit plus the 20-second finance property limit under concurrent track load, while the same affected A tests passed on its isolated stack. Please account for concurrent full-gate contention in the hourly gate. Track A is testing a bounded-worker merge run; no assertion or timeout has been weakened.
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
