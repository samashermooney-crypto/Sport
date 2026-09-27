# Track H — communications and chat

Status: Phase 10 complete on trunk; sprint Phase 11 is WIP; Phase 13 moved to Track J (federation draft removed)
Branch: `track/h-comms` (local only; no push)
Merged trunk at sprint start: `rebuild/trunk` / `d991fee`
Sprint local range: `d991fee..HEAD` (WIP implementation and handoff checkpoints; local only)
Migration ranges: Phase 10 `4000–4006`; Phase 11 `8000–8499` (Phase 13 is J's `6000–6999`)

## Delivered

- Campaign APIs and composer for people, teams, programs and roles; registration-status and past-due filters; bilingual merge fields; live draft and saved previews; in-app/email/SMS/push channel selection; test send; schedule/cancel; delivery stats; and emergency broadcasts restricted to owner/admin.
- Delivery uses Track C's email/SMS/push adapters, stores provider message IDs for signed Resend/Twilio status callbacks, and applies dedupe, guardian routing, preferences, suppression, SMS consent, shared quiet-hours rules and bounded retries. Development and tests use preview, fake or Mailpit adapters.
- In-app campaign, emergency and chat events pass their Phase 10 type IDs (`communications.campaign`, `communications.emergency`, `communications.chat_message`) through Track B's notification catalog. H's en/es templates are exported from the communications module and checked against B's catalog IDs.
- Tokenized email unsubscribe applies the category preference and offers Track B's `preferencesCenterPath(orgId)` in the localized confirmation page.
- Team/staff chat uses the shared SafeSport policy, includes guardians, rejects unguarded adult/minor direct conversations, supports read receipts, mute, edits/soft deletion, moderation and report-to-compliance, and publishes inbox/SSE notifications through Track B.
- Unread chat fallback batches by conversation and recipient for ten minutes from the first message (DEC-063). It rechecks active membership, mute and unread state, uses Track B operational preferences, sends push first and email only as fallback, defers push through shared quiet hours, redacts message content, and retries provider failures. Migrations `4005`–`4006` store tenant-scoped batch state and its foreign-key indexes.
- Person and household message-history APIs and internal attachment references are present. Added Phase 10 browser journeys for campaign composition/preview/test/schedule-cancel and portal chat send; both run in Chromium and WebKit mobile with axe checks.
- `npm run gen:module communications` was run; it declined to overwrite the existing module. Generated registry and OpenAPI were refreshed.

## Verification

- Targeted H Postgres integration tests: 21 passed. Coverage includes tenant and role enforcement, all Phase 10 notification IDs, tokenized unsubscribe destination, provider-ID callbacks, chat grouping, unread/muted suppression, push/email preferences and quiet-hour deferral.
- Full `npm test`: 182 files passed, 1 skipped; 689 tests passed, 1 skipped.
- H Playwright journeys: 4 passed across Chromium desktop and WebKit mobile. Full `npm run test:e2e`: 40 passed, 4 skipped; axe checks in the H journeys reported no serious or critical violations.
- `npm run db:migrate` applied migrations `0202_household_member_history.sql`, `1040_manual_installment_payments.sql` and H migrations `4005_chat_notification_batches.sql`–`4006_chat_notification_batch_indexes.sql`; `npm run db:codegen` introspected 160 tables.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run registry`, `npm run openapi` and `git diff --check` passed against the merged trunk. Build emitted upstream dependency/chunk-size advisories only.
- No real email, SMS or push was sent. The branch was not pushed.

## Remaining work owned by other tracks

- **A:** Link H history from person/household profiles; capture consent when a verified phone is entered; expose `programs.settings.communications.athleteChatEnabled`; call H's existing team/staff conversation synchronization after roster, staff, guardian-link and setting changes; add coach-to-16-year-old guardian-copy and remaining Phase 10 Chromium/WebKit mobile journeys with axe; surface bounce suppressions in Action Center.
- **C:** Authorize family chat attachment upload/download for active same-organization conversation members in the Files module.
- **G:** Coalesce five schedule changes within fifteen minutes into one family communication.

## Completion boundary

Track B's catalog/preferences and Track C's provider-ID interface are on the merged trunk and wired by H. Track H-owned work is complete and ready for integration. Overall Phase 10 still awaits the A/C/G items above and their acceptance journeys.


## HANDOFF (Devin/SWE-2 Max continuation)

Status: WIP — Phase 11 services drafted; federation removed per owner reassignment to Track J.

### Done

- Sprint baseline merged locally: `track/h-comms` fast-forwarded to `rebuild/trunk` at `d991fee`.
- Phase 11 migrations `8000–8003` define volunteers, team finance, fundraising, sponsors, store operations, inventory balance protection, product tax references, and guest donation checkout metadata. Applied to the H dev DB.
- Volunteer and team-finance APIs exist and passed `npm run typecheck` before the store and fundraising additions. Store APIs use E's invoice repository, household checks, product tax rates, stock reservations, paid-invoice reconciliation, fulfillment, and uniform size reporting.
- Fundraising has campaign views, public Turnstile-checked guest donation APIs, encrypted EIN settings, donor statements, receipt handling, and a `GuestDonationCheckoutPort` seam. The current trunk E payment adapter does not implement that guest contract yet.
- Federation work removed from this track in one commit (files were `db/migrations/8400*.sql`, `server/src/modules/federation/`); dev DB federation tables dropped and `types.ts` regenerated (188 tables).
- The isolated H stack uses `COMPOSE_PROJECT_NAME=athlentry_h PORT_OFFSET=800` (postgres `127.0.0.1:6232`, mailpit API `8825`, stripe-mock `12911`) and is already running. No messages or payments were sent.

### In progress — exact paths

- `db/migrations/8000_phase11_program_operations.sql`–`8003_guest_donation_checkout.sql`
- `server/src/db/types.ts` (regenerated)
- `server/src/modules/volunteers/{module,routes,schema,service}.ts`
- `server/src/modules/team-finance/{module,routes,schema,service}.ts`
- `server/src/modules/store/{module,routes,schema,service}.ts`
- `server/src/modules/fundraising/{checkout,module,routes,schema,service}.ts`
- No Phase 11 web screens or new Playwright journeys have been added yet.

### Exact next steps

1. Fix the lint leftovers: `fundraising/routes.ts:46` unsafe template literal; `fundraising/service.ts` unused `newId` import and non-null assertions at the `rows[0]!` sites; `store/service.ts:83` use `const`; `volunteers/service.ts` unnecessary numeric conversions and one unused expression.
2. Finish Phase 11 services and UI: fundraising payment completion/receipt delivery through E/C's guest adapter/webhook interface; sponsor CRUD, placements, renewals and finance invoice path; store catalog/order/fulfillment portal and console UI; volunteer and team-finance UIs.
3. Add B-catalog Phase 11 notification IDs and C requests for webhook dispatch, web route discovery, and migration/registry integration; do not edit their owned catalog/router paths directly.
4. Add tenancy/permission, inventory concurrency, donation, volunteer and team-fee integration tests plus Phase 11 Chromium and WebKit-mobile Playwright journeys with axe. Then run targeted tests, lint, build and the sprint merge gate before self-merging.

### Requests to J

- Phase 13 federation is fully yours (migrations `6000–6999`). H's discarded draft is retrievable from commit `c16c555` (`db/migrations/8400_federation.sql`, `8401_federation_data_agreement.sql`, `server/src/modules/federation/schema.ts`) if useful — it covers `org_relationships` with dual-tenant RLS + per-dataset `data_sharing` consent versioning (`data_sharing_version` + per-side accepted versions), `federation_programs/team_entries/field_availability/fixtures/discipline_summaries`, and append-only `federation_access_audits` written in both tenants. Zod request/response DTOs are in the same commit.
- The H dev DB previously had these applied as versions `6000`/`6001` — if you reuse those version numbers, no conflict remains here; the tables were dropped and the rows deleted.

### Open requests / ownership boundaries

- **E:** Implement the `GuestDonationCheckoutPort` contract in `server/src/modules/fundraising/checkout.ts` through the existing finance/payment adapters; preserve guest donations without synthetic Athlentry accounts or invoices.
- **C:** Dispatch signed payment completion/failure webhooks to `markDonationPaid` and related fundraising handlers; wire generated server/web registries and H routes on trunk.
- **B:** Register `fundraising.donation_receipt`, `fundraising.campaign_update`, `sponsor.renewal_reminder`, `store.order_update`, `volunteer.shift_reminder`, `volunteer.requirement_behind`, `team.fee_assessed`, and `team.reimbursement_decided` in the notification catalog.
- **A/C (Phase 10 follow-ups remain external):** Profile message-history links, phone consent capture, `athleteChatEnabled`, conversation sync calls, chat attachment authorization, and provider/webhook wiring described in the previous section remain outstanding.

### Current local range

- `d991fee..HEAD` (local WIP, no push; includes the implementation and handoff commits).

## HANDOFF

### State at handoff

- Track H checkout is clean on `track/h-comms` at `8aa4d97`, with merge base `9b5b430` (`rebuild/trunk`). Local range: `9b5b430..HEAD`; no push.
- Phase 10 H-owned work is recorded above as complete. Phase 11 is WIP and has not passed its acceptance gate. Phase 13 is not in this checkout; `track/j-federation` is at `c7a9561` and remains unreviewed/unmerged. The owner directed H to finish Phase 13 after Phase 11 by merging J's work.
- Current H-owned Phase 11 implementation files:
  - `db/migrations/8000_phase11_program_operations.sql`
  - `db/migrations/8001_volunteer_scope.sql`
  - `db/migrations/8002_store_product_tax_rates.sql`
  - `db/migrations/8003_guest_donation_checkout.sql`
  - `db/migrations/8004_sponsor_renewal_notice.sql`
  - `db/migrations/8005_store_low_stock.sql`
  - `server/src/db/types.ts`
  - `server/src/generated/registry.ts`
  - `shared/src/generated/errors.ts`
  - `shared/src/generated/permissions.ts`
  - `server/src/modules/volunteers/{module,routes,schema,service}.ts`
  - `server/src/modules/team-finance/{module,routes,schema,service}.ts`
  - `server/src/modules/fundraising/{checkout,module,preview-checkout,routes,schema,service}.ts`
  - `server/src/modules/sponsors/{module,routes,schema,service}.ts`
  - `server/src/modules/store/{module,routes,schema,service}.ts`
- No Phase 11 web UI or Phase 11 Playwright journeys exist yet. Relevant H-owned web paths to create are `web/src/console/volunteers/**`, `web/src/console/team-finance/**`, `web/src/console/fundraising/**`, `web/src/console/sponsors/**`, `web/src/console/store/**`, and corresponding portal/public fundraising/store paths where required by the Phase 11 journeys. Route mounting remains a Track C interface/wiring request.
- Migrations `8000`–`8003` were reported applied to the isolated H database by the prior session. Application of `8004`–`8005` is unverified. Isolated stack identity: `COMPOSE_PROJECT_NAME=athlentry_h`, `PORT_OFFSET=800` (previously recorded ports: Postgres 6232, Mailpit API 8825, stripe-mock 12911; health not checked during this handoff).

### Verification and known failures

- The prior session reported `npm run typecheck` and `npm run lint` passing after the Phase 11 WIP commits. This handoff did not rerun them.
- No known failing test is confirmed for the current WIP. Phase 11 targeted database tests, the full suite, Phase 11 Playwright journeys, and the sprint merge gate have not been run against these commits. Do not treat unrun tests as passing.
- No Phase 11/13 work has been merged to `rebuild/trunk`; no merge gate was established as green, so no self-merge was attempted.
- No real email, SMS, push, or payment was sent or processed.

### Exact next steps

1. Merge current `rebuild/trunk` into `track/h-comms`; inspect conflicts and generated registries/types, then apply and verify migrations `8000`–`8005` on the isolated H database.
2. Review the Phase 11 service code in the paths above against the Phase 11 acceptance criteria, correct financial/tenant/privacy issues, and finish the guest donation completion/receipt flow using E's invoice/payment interfaces and fake/preview providers only.
3. Request B to register the Phase 11 notification types, and request C to wire the signed payment completion/failure dispatch and discover/mount the Phase 11 API and web routes. Build against their interfaces while they are pending; do not duplicate B's notification catalog or edit C-owned routers.
4. Add and run targeted database/permission tests for volunteer shifts, compliance and buyout; installment assessment/payment and reimbursement approval; guest donation completion/receipt; sponsor invoices/renewals; uniform add-on reporting; and concurrent inventory reservation. Use the isolated H stack and never skip DB-backed tests.
5. Implement the missing console, portal and public Phase 11 flows using only `web/src/ui` components/tokens. Cover volunteer signup/check-in/credit/buyout, team fee ledger and reimbursement, fundraising/donation, sponsor management, store/fulfillment and uniform reporting. Add the possible Phase 11 Playwright acceptance journeys for Chromium desktop and WebKit mobile with axe; invoke every Playwright run and full-suite run through `~/athlentry-sprint/heavy.sh`.
6. Run the full sprint merge gate, fix failures without weakening tests, and self-merge H's green Phase 11 work using the trunk lock and no-commit protocol.
7. Merge `track/j-federation` into H, review its WIP and migration `6000` within the assigned `6000–6999` range, complete the federation acceptance criteria, and add targeted tenancy/permission and Chromium/WebKit-mobile axe journeys. Log product/engineering decisions in `docs/codex/DECISIONS.md`.
8. Run the full gate for Phase 13 and self-merge only when green. Update this track file with exact local ranges, outstanding other-track requests, and the verified acceptance state; only then mark the sprint complete.

### Open requests / dependencies

- **E:** Finish the guest donation payment completion interface in `server/src/modules/fundraising/checkout.ts` using E's payment services, preserving guest donations without synthetic Athlentry accounts or invoices.
- **B:** Register H's Phase 11 notification IDs: `fundraising.donation_receipt`, `fundraising.campaign_update`, `sponsor.renewal_reminder`, `store.order_update`, `volunteer.shift_reminder`, `volunteer.requirement_behind`, `team.fee_assessed`, and `team.reimbursement_decided`.
- **C:** Dispatch signed payment completion/failure webhooks to fundraising handlers; wire generated server/web registries and feature routes.
- **J:** Review and merge `track/j-federation` (`c7a9561`) after Phase 11, then complete Phase 13 on H as directed by the owner.
- **A/C (Phase 10 follow-ups):** Profile message-history links, verified-phone consent capture, `athleteChatEnabled`, conversation sync calls, and chat attachment authorization remain external dependencies listed above.
HANDED OFF 09:50
