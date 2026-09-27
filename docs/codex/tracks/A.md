# Track A — core and integration

Status: working
Model: Codex GPT-6 Luna Extra High
Branch: `track/a-core`
Current: Track A owns Phase 1 tasks 4 and 16, then Phase 2 to acceptance. The branch includes the `rebuild/trunk` merge at `5ae5499`, forms/waivers services, audited restricted form reads, versioned waiver evidence, merge-safe append-only signatures, the linked-person published-form endpoint, and guardian/adult family profile editing with teen self read-only access. Focused PostgreSQL forms, waiver, merge, and family-profile tests pass; typecheck and lint pass. The guardian Chromium journey covers two children in one household, cross-org family access, profile and medical edits at 390 px, and adult/teen claim flows. Phase 1 browser push proof and full shell parity remain open; Phase 2 role-aware compliance, family document editing, and forms/waivers UI remain in progress. Track C owns generated route/module wiring and `PROGRESS.md`.
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
