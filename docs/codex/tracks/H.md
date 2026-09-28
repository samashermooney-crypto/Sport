# Track H — communications and chat

Requests from OPS: Confirm the campaign enqueue/status API contract for a 20,000-recipient fan-out using only preview/fake delivery adapters, including a durable completed-recipient count for the k6 scenario (2026-09-27).

Status: Phase 10 H-owned work is ready for integration; Phase 11 is complete and green on trunk; Phase 13 belongs to Track J
Branch: `track/h-comms` (local only; no push)
Merged trunk at sprint start: `rebuild/trunk` / `d991fee`; synchronized branch includes `rebuild/trunk` `f091afce`
Current synchronized base: `rebuild/trunk` `d0385562`; sprint changes remain local and unpushed
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

## Phase 11 progress

- Implemented volunteer operations, team ledgers and fee assessments, fundraising and encrypted nonprofit receipt settings, sponsor records and invoices, store inventory and uniform add-ons/reports, plus console, family portal and public fundraising flows. Existing invoice repositories handle team, sponsor and store billing.
- Added shipping-address capture at store checkout and manager fulfillment display. Added migrations `8009_team_season_ledgers.sql` and `8010_phase11_foreign_key_indexes.sql`; the isolated database has applied both. Refreshed generated registry and OpenAPI output.
- Targeted Phase 11 Postgres suites pass: 5 files, 13 tests. They cover volunteer and finance permission boundaries, donation receipts, sponsor invoicing/placements, shipping address snapshots, uniform add-on reporting, and concurrent inventory/idempotency behavior.
- Phase 11 Playwright journeys pass: 8 runs across Chromium desktop and WebKit mobile, covering the three specified volunteer/team-finance/donation acceptance flows plus ship-to fulfillment. Axe reported no violations. A first parallel run had one donation receipt assertion miss the tax acknowledgment; the persisted settings assertion, isolated rerun and complete Phase 11 rerun all passed.
- Full Chromium desktop Playwright suite passes on the merged trunk tree: 37 passed, 6 skipped. An earlier parallel run had a transient campaign-scheduling busy-state assertion; the isolated journey and full serial rerun passed.
- `npm run typecheck`, `npm run lint`, and `npm run build` pass. Build reports existing Zod annotation, chunking and bundle-size advisories. Full Vitest passes on trunk: 245 files passed, 1 skipped; 873 tests passed, 1 skipped.
- Track H sprint complete: the H/J trunk merge gate passed with typecheck, lint, Vitest and Chromium green.
- Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_h`, `PORT_OFFSET=800`; Postgres `6232`, Mailpit API `8825`, Stripe mock `12911`. Tests use fake/preview providers; no real email, SMS, push or payment was sent.

### Next steps

- Track H Phase 11 is integrated. The other-track requests below remain with their owners.

### Open requests

- **OPS:** Confirm the campaign enqueue/status API contract for 20,000-recipient fan-out using preview/fake adapters and expose a durable completed-recipient count for k6.
- **E/C:** Production guest-donation checkout and signed payment-completion/failure dispatch for `server/src/modules/fundraising/checkout.ts`; dev/test preview checkout is implemented. Confirm registration add-on inventory reservation ownership with E.
- **B:** Register Phase 11 notification catalog IDs/templates: `fundraising.donation_receipt`, `fundraising.campaign_update`, `sponsor.renewal_reminder`, `store.order_update`, `store.low_stock`, `volunteer.shift_reminder`, `volunteer.requirement_behind`, `team.fee_assessed`, and `team.reimbursement_decided`; provide volunteer administration picklists. H services currently skip catalog-gated notifications until those IDs exist.
- **C/D:** Authorize safe public sponsor-logo delivery and confirm public sponsor/store page wiring through the website routes.
- **A:** Phase 10 profile/history links, verified-phone consent, `athleteChatEnabled`, and conversation synchronization.
- **C:** Phase 10 same-organization conversation-member attachment authorization.
- **G:** Phase 10 schedule-change coalescing.
- **OPS:** Confirm the 20,000-recipient campaign enqueue/status contract and durable completed-recipient count.
- **J:** Owns Phase 13 federation; H does not merge `track/j-federation`.
- **Phase 10 external work:** A still owns profile message-history links, verified-phone consent, `athleteChatEnabled`, and conversation synchronization; C owns chat attachment authorization; G owns schedule-change coalescing.
## Requests from QA

- **QA-ACC-021:** extend the communications browser journey through quiet-hour deferral and tokenized unsubscribe; current browser coverage stops after schedule cancellation.
- **QA-ACC-037:** run the Phase 11 $300 donation acceptance path anonymously. The current scenario keeps its authenticated setup session while completing the public fundraiser checkout.
- **QA-SEC-009:** limit household volunteer ledger reads to the verified guardian of that household or an authorized volunteer-oversight role; active program-scoped memberships currently pass the service access check.
- **QA-ACC-038 (coordinate E):** connect family uniform orders to the selected athlete's registration/team for size reporting, and reject unrelated team-season IDs. The current store portal omits both attribution fields that the report requires.
- **QA-ACC-039:** make volunteer buyout reservation and invoice issuance atomic under concurrency; a late conflicting request currently leaves its issued invoice behind.
- **QA-ACC-040:** make `countsCoachRoles` affect household requirement credits; it is persisted but the ledger only counts completed volunteer signups.
- **QA-ACC-041:** implement idempotent notice and shortfall-invoice enforcement for enabled volunteer requirements; `autoInvoiceShortfall` and `noticeDays` are stored but no job consumes them.
- **QA-ACC-042:** add event-block shift generation and a deduplicated shift-reminder job; the volunteer module has no jobs and creates shifts one at a time.
- **QA-ACC-043 (coordinate B):** register and emit purchaser order-status notifications after fulfillment transitions; `updateFulfillment()` currently changes state without enqueuing a notification.
- **QA-ACC-044 (coordinate E/C):** provide a production guest-donation checkout adapter through the fundraising route/module contract; the current route returns 503 `CHECKOUT_UNAVAILABLE` because no provider is supplied. Keep preview checkout non-production-only and settle payments only through signed webhook events. See `docs/codex/qa/DEFECTS.md` (2026-09-27).
- **QA-ACC-045 (coordinate B):** add notification catalog support and verify the sponsor renewal job creates a single reminder for expiring active contracts; the current service returns zero before scanning because `sponsor.renewal_reminder` is not registered. The active regression is `e2e/phase11-sponsor-renewal.spec.ts` (2026-09-27).
- Track I trunk-gate note (2026-09-27): the sponsor placement integration fixture derived `contractStart` from UTC `toISOString()` while `publicSponsorPlacements` correctly compares against the organization-local date. The fixture now uses `orgToday()` for the owning organization timezone and a `Temporal.PlainDate` offset for `contractEnd`; no sponsor runtime behavior changed.
