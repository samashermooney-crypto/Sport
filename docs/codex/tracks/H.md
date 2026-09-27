# Track H — communications and chat

Status: Phase 10 complete on trunk; sprint Phase 11 and explicitly assigned Phase 13 work are WIP
Branch: `track/h-comms` (local only; no push)
Merged trunk at sprint start: `rebuild/trunk` / `d991fee`
Sprint local range: starts at `d991fee`; WIP is committed in the handoff range below
Migration ranges: Phase 10 `4000–4006`; Phase 11 `8000–8499`; Phase 13 files use H-range `8400–8401` per the direct owner assignment (SPRINT.md otherwise lists Phase 13 under J)

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


## HANDOFF

Status: WIP; do not treat the old Phase 10 verification above as a Phase 11/13 gate.

### Done

- Sprint baseline is merged locally: `track/h-comms` fast-forwarded to `rebuild/trunk` at `d991fee`.
- Phase 11 migrations `8000–8003` define volunteers, team finance, fundraising, sponsors, store operations, inventory balance protection, product tax references, and guest donation checkout metadata.
- Volunteer and team-finance APIs exist and passed `npm run typecheck` before the store and fundraising additions. Store APIs use E's invoice repository, household checks, product tax rates, stock reservations, paid-invoice reconciliation, fulfillment, and uniform size reporting.
- Fundraising has campaign views, public Turnstile-checked guest donation APIs, encrypted EIN settings, donor statements, receipt handling, and a `GuestDonationCheckoutPort` seam. The current trunk E payment adapter does not implement that guest contract yet.
- Phase 13 schema and migrations are in progress under H's `8400–8499` range in response to the direct owner assignment. SPRINT.md still assigns federation to J and lists J's `6000–6999` range; this overlap needs coordination before trunk integration.
- The isolated H stack uses `COMPOSE_PROJECT_NAME=athlentry_h PORT_OFFSET=800` and was already started. No messages or payments were sent by the new work.

### In progress — exact paths

- `db/migrations/8000_phase11_program_operations.sql`
- `db/migrations/8001_volunteer_scope.sql`
- `db/migrations/8002_store_product_tax_rates.sql`
- `db/migrations/8003_guest_donation_checkout.sql`
- `db/migrations/8400_federation.sql`
- `db/migrations/8401_federation_data_agreement.sql`
- `server/src/db/types.ts`
- `server/src/modules/volunteers/{module,routes,schema,service}.ts`
- `server/src/modules/team-finance/{module,routes,schema,service}.ts`
- `server/src/modules/store/{module,routes,schema,service}.ts`
- `server/src/modules/fundraising/{checkout,module,routes,schema,service}.ts`
- `server/src/modules/federation/schema.ts`
- No Phase 11/13 web screens or new Playwright journeys have been added yet.

### Exact next steps

1. Resolve the H dev database's existing `schema_migrations` rows for old federation versions `6000/6001` before applying the renamed H migrations `8400/8401`; then run `npm run db:migrate` and `npm run db:codegen` on the H stack.
2. Fix the current typecheck failures in `server/src/modules/fundraising/service.ts`; remove the unused `newId` import and regenerate types for migration `8003` columns `checkout_session_id`, `provider_payment_id`, and `creation_key`.
3. Finish Phase 11 services and UI: fundraising payment completion and receipt delivery through E/C's guest adapter/webhook interface; sponsor CRUD, placements, renewals and finance invoice path; store catalog/order/fulfillment portal and console UI; volunteer and team-finance UIs.
4. Implement federation relationship consent/versioning, audited allowlisted cross-org roster/compliance/availability reads in both tenants, entry submission/approval, schedule generation, results/standings, and relationship termination tests.
5. Add B-catalog Phase 11 notification IDs and C requests for webhook dispatch, web route discovery, and migration/registry integration to this file; do not edit their owned catalog/router paths directly.
6. Add tenancy/permission, inventory concurrency, donation, volunteer and team-fee integration tests plus Phase 11/13 Chromium and WebKit-mobile Playwright journeys with axe. Then run targeted tests, lint, build and the sprint merge gate before self-merging.

### Known failures and unrun checks

- `npm run typecheck` currently fails. `server/src/modules/fundraising/service.ts` has an unused `newId` import and references `donations.checkout_session_id`, `donations.provider_payment_id`, and `donations.creation_key` before generated DB types include migration `8003`.
- The pre-commit `eslint --fix` check also failed and rolled back its autofix. Remaining lint items: `fundraising/routes.ts:46` unsafe template literal; `fundraising/service.ts:1,93,96,186–187` unused import, non-null assertions and unsafe/nullable access; `store/service.ts:83` use `const`; `volunteers/service.ts:256,334,360,387,438,472,688` unnecessary numeric conversions and one unused expression.
- The required WIP checkpoint commit bypasses the pre-commit hook after recording these failures; it is not a green merge commit.
- No tests, build, migration or Playwright run has been completed after the current WIP edits. The pre-commit lint ran and failed as listed above; there are no known test failures because test suites have not run.
- Do not merge this WIP: its merge gate is not green. No new sprint commit is on trunk.

### Open requests / ownership boundaries

- **E:** Implement the `GuestDonationCheckoutPort` contract in `server/src/modules/fundraising/checkout.ts` through the existing finance/payment adapters; preserve guest donations without synthetic Athlentry accounts or invoices.
- **C:** Dispatch signed payment completion/failure webhooks to `markDonationPaid` and related fundraising handlers; wire generated server/web registries and H routes on trunk.
- **B:** Register `fundraising.donation_receipt`, `fundraising.campaign_update`, `sponsor.renewal_reminder`, `store.order_update`, `volunteer.shift_reminder`, `volunteer.requirement_behind`, `team.fee_assessed`, and `team.reimbursement_decided` in the notification catalog.
- **J:** SPRINT.md assigns Phase 13 and migrations `6000–6999` to J, while the direct owner assignment added federation to H. Confirm no overlapping J files/migrations before federation integration; H's current draft uses `8400–8401`.
- **A/C (Phase 10 follow-ups remain external):** Profile message-history links, phone consent capture, `athleteChatEnabled`, conversation sync calls, chat attachment authorization, and provider/webhook wiring described in the previous section remain outstanding.

### Current local range

- `d991fee..` (WIP commit: recorded in the following handoff commit).
