# Track C — files and adapters
Status: handoff prepared; Phase 15 merge needs full verification
Branch: `track/c-adapters`
Current: local commit `63871e0` merges Track K's Phase 15 branch. Its second parent, `17dcd85`, was explicitly marked unverified WIP. Trunk fix `9b5b430` is reported landed; CI `test` and Knip are green, with design parity assigned to Track D's successor.
Ready for integration: no. Verify local additions `657fb30..63871e0` and rerun the complete gate before offering this branch to Track A.
Requests to other tracks: A/B's frozen payer quote and payer-owned checkout/invoice IDs are prerequisites for mounting `CheckoutPaymentScreen`; Track B's route arrays are not yet in this branch.
Blocked on: verification of the K merge, plus external contracts/modules noted in the handoff below.

Queue notes: 1) Linked guardians can upload restricted `person_credential` and `return_to_play_clearance` evidence; owner/compliance roles can download; every Restricted read is audited and unauthorized readers receive 404. 2) Email returns SMTP/Resend IDs; fakes return stable fake IDs; bilingual templates remain available. 3) Stripe belongs to Track E. 4) Twilio, preview and fake SMS return provider IDs; signed inbound/status callbacks and STOP/START/HELP suppression remain supported. 5) Push returns provider IDs when available, preserves invalid-endpoint cleanup and propagates transient errors. 6) Manual/Checkr providers and the recorded fixture are implemented. 7) Nominatim is optional, cached, limited to one request per second per process, privacy-filtered, HTTPS allow-listed and exposes attribution. 8) Chat attachments accept images/PDF for active same-org conversation members; downloads require membership in a live conversation referencing the file. Images are re-encoded with EXIF/GPS metadata stripped; Restricted authorization and per-read audit behavior remain in force.
Self-review: file and conversation lookups stay within `withOrg`; revoked or archived memberships cannot upload or download. Linked-only accounts reach the files authorization check. Unscoped pre-message uploads become downloadable only after a live chat message references the file, and only by active conversation members. Restricted files do not use the chat exception. Raw Stripe bytes reach signature verification before JSON parsing; the runtime rejects non-test Stripe API secrets.

## HANDOFF

### Done

- Trunk CI repair `9b5b430`: the fresh-database migration privilege fix and Knip cleanup are on trunk. The owner reports GitHub `test` and Knip green; never use live keys or real messages.
- Track C adapter work is committed in the branch history: raw Stripe webhook ingress and worker registration; generated registry/OpenAPI and nested feature routing; finance console/portal mounts; restricted-file authorization/audit; active-member chat attachment upload/download and image metadata stripping; provider message IDs; and Mailpit SMTP port configuration.
- Mailpit reads `ATHLENTRY_MAILPIT_SMTP_PORT` with default 1025 in `server/src/integrations/email/sender.ts`; covered by `server/src/integrations/email/sender.test.ts`.
- Track K Phase 15 is now committed as merge `63871e0` (parents `657fb30` and `17dcd85`). It includes onboarding, imports, help and AI files, migration `db/migrations/8500_phase15_growth.sql`, schemas, generated routes/OpenAPI and demo seed work. The commit hook passed lint/format and TypeScript typecheck. The targeted `server/test/onboarding-ai-help.test.ts` passed 12/12 against the isolated Postgres test template. Treat the K parent as unverified until reviewed and fully gated.

### Wiring requests handled

- Track F restricted files: `server/src/modules/files/module.ts`, `server/src/modules/files/routes.ts`, `server/src/modules/files/service.ts`, `server/src/modules/files/service.integration.test.ts`.
- Track H chat attachments: `server/src/modules/chat/service.ts`, `server/src/modules/chat/service.integration.test.ts`, and the files routes/service above.
- Track H provider IDs: `server/src/integrations/email/sender.ts`, `server/src/integrations/sms/sender.ts`, and `server/src/integrations/push/sender.ts`, with provider tests alongside them.
- Track E existing finance wiring: `server/src/app.ts`, `server/src/worker.ts`, `server/src/modules/finance/module.ts`, `server/src/generated/registry.ts`, `scripts/openapi.ts`, `docs/api/openapi.json`, `web/src/generated/nested-routes.ts`, `web/src/console/money/routes.tsx`, and `web/src/portal/money/routes.tsx`. The Connect routes and current finance screens are mounted; Stripe stays test-mode only.
- Track K route discovery: `server/src/modules/{ai,help,imports,onboarding}/`, `web/src/console/{ai,imports,onboarding}/`, `web/src/help/`, `web/src/generated/`, and the shared growth/import schemas.

### Open wiring / integration requests

- Track B console routes and navigation are not present yet: when B's files land, mount `web/src/console/programs/routes.tsx`, `web/src/console/teams/routes.tsx`, and `web/src/console/facilities/routes.tsx` from `web/src/console/routes.tsx`, and add Programs/Teams/Facilities links in `web/src/console/Home.tsx` or its navigation owner. B also asks A/C to move file-route and B module contracts to shared Zod schemas, migrate A-owned mutable org routes to version helpers, and align `FILE_INVALID` with the shared error envelope. Recheck the B request before claiming it closed.
- Track E registration wiring is waiting on its module branch: `server/src/modules/registration/module.ts` and `web/src/portal/registration/routes.tsx` are absent here. After they land, register the module, regenerate registry/OpenAPI and DB types, then mount the registration portal route/navigation and run its Postgres/UI tests.
- Track E checkout UI remains contract-gated: mount `CheckoutPaymentScreen` only after A/B supplies payer-owned checkout/invoice IDs and the frozen quote; call `PostgresCheckoutInvoiceLinker.link(checkoutId, invoiceId)` before presenting a PaymentIntent. A's `charges_enabled` offering gate and frozen checkout settings remain A-owned dependencies.
- Track E requests that arrive with its next merge need another registry/OpenAPI pass, including newly added finance routes and binary PDF response media types. Track E also requests `installment.failed` and `installment.final_notice` fanout to consented push/SMS when the comms workers are ready.
- Track OPS requests remain open: wire `/readyz` and public `/status` through generated routing; initialize the OPS logger and Sentry hooks in web/worker; add `keys:generate` and `keys:vapid`; wire heartbeat, pg-boss queue/failure, Stripe webhook-silence, payment-failure and email-bounce checks to the alert sink; remove `DATABASE_ADMIN_URL` from the web runtime after pre-deploy use.
- Review Phase 15 against its disabled-provider behavior before integration: when AI is disabled, no AI UI or AI network calls should occur. Confirm public assistant scope and public-content sources against the spec; the merged code has not had its full acceptance gate run.

### Next steps

1. Review the full K diff in `17dcd85` and merge `63871e0`; do not assume the WIP parent is correct merely because the merge committed.
2. Use the isolated real-Postgres stack (`COMPOSE_PROJECT_NAME=athlentry_c`, currently `PORT_OFFSET=900`, Postgres port 6332; Mailpit 1925, Stripe mock 13011). Request escalated permission for Docker/DB commands. Run focused Files/RLS, chat attachment and Phase 15 Postgres tests, then the full test, typecheck, lint, Knip, build, OpenAPI/registry/codegen and E2E gates. Do not skip DB tests or relax assertions.
3. Recheck and implement the open B, E and OPS wiring requests above as their owning changes land; regenerate artifacts and add coverage for each seam.
4. Re-run `e2e/ownership-transfer.spec.ts` through the heavy gate. A prior adapter-on-trunk Chromium run timed out waiting for the “Scoped role granted” notice at line 140 even though the role mutation succeeded; the full adapter E2E run before that merge had passed.
5. When every required gate is green, update this file with the precise integration range and request Track A integration. Do not push from this worktree.

### Gate state and environment

- Last known trunk CI: `test` and Knip green per owner; only `e2e/design/parity.spec.ts` remains assigned to Track D's successor (Linux baseline/390px parity).
- The red trunk cases reported before `9b5b430` were compliance Phase 7 integration (3), installment-charge repo (3), chat attachment integration, finance credit route, and Knip; the owner reports the test and Knip jobs now pass.
- After merge `63871e0`, only the pre-commit lint/format and typecheck hook plus the targeted 12-test onboarding/AI/help suite are verified. The full post-merge test/E2E/static/build gate is outstanding. Before K merged, C's full test suite passed 726 tests with 1 existing skip and E2E passed 42 with 4 configured skips.
- C stack: `COMPOSE_PROJECT_NAME=athlentry_c`, `PORT_OFFSET=900`, Postgres `127.0.0.1:6332`, Mailpit 1925, Stripe mock 13011. Offset 500 was occupied by Track E when this stack was started; check availability before changing it.
- `/Users/sammooney/Sport-trunk` is clean at `56f2789` (ahead of origin by four commits). `/tmp/athlentry-trunk.lock` is absent.
