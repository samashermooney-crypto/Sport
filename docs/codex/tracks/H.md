# Track H — communications and chat

Status: Phase 10 H-owned work is ready for integration; Phase 11 is in progress; Phase 13 belongs to Track J
Branch: `track/h-comms` (local only; no push)
Merged trunk at sprint start: `rebuild/trunk` / `d991fee`; current sync includes `5ae54998` and must also absorb latest `rebuild/trunk` `f091afce`
Sprint local range: `af353fc..HEAD` (local only; no push)
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

- WIP checkpoint commits: `c2eaee1`, `19c5290`, `02ea74a`. Current branch is `track/h-comms`; Phase 11 has not passed acceptance or been merged to trunk.
- Implemented volunteer, team-finance, fundraising, sponsor, store, family portal, console and public fundraising/sponsor surfaces in H-owned paths. Store shipping migration `8008` was applied on the isolated dev database; `server/src/db/types.ts` regenerated with 188 tables.
- Targeted Phase 11 database suites now pass: 5 files, 12 tests (volunteers, team finance, fundraising, sponsors and store), including shipping-address validation/snapshot and sponsor invoice/placement checks.
- On the synchronized tree, `npm run typecheck`, `npm run lint`, `npm run registry` and `npm run openapi` pass. The isolated dev database has migrations through `3017` and `8008`; type generation reports 203 tables. Phase 11 Playwright journeys and the merge gate remain incomplete.
- Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_h`, `PORT_OFFSET=800`; Postgres `6232`, Mailpit API `8825`, Stripe mock `12911`. No real email, SMS, push or payment was sent.

### Next steps

1. Finish syncing `track/h-comms` with latest `rebuild/trunk` (`f091afce`) and review generated registries/routes and migrations through `8008`.
2. Run and extend targeted tenant/permission DB tests for volunteers, team finance, fundraising, sponsors, store inventory/add-ons and immutable shipping-address snapshots.
3. Complete Phase 11 acceptance flows and integrate E's invoice/payment contracts; build only with `web/src/ui`.
4. Add Chromium and WebKit mobile Phase 11 journeys with axe; use `~/athlentry-sprint/heavy.sh` for Playwright and full suites.
5. Run the SPRINT.md merge gate. Merge to trunk only after the gate is green using the trunk lock and `--no-ff --no-commit` protocol.

### Open requests

- **E:** Implement the guest donation payment completion contract used by `server/src/modules/fundraising/checkout.ts`; provide sponsor billing-account semantics and registration add-on inventory reservation integration.
- **B:** Register Phase 11 catalog IDs: `fundraising.donation_receipt`, `fundraising.campaign_update`, `sponsor.renewal_reminder`, `store.order_update`, `store.low_stock`, `volunteer.shift_reminder`, `volunteer.requirement_behind`, `team.fee_assessed`, and `team.reimbursement_decided`; provide volunteer administration picklists.
- **C:** Dispatch signed payment completion/failure webhooks, mount generated server/web registries and H routes, and wire jobs.
- **D/C:** Provide safe public sponsor-logo delivery and mount public fundraising/store/sponsor pages.
- **A:** Household address capture UI and Phase 10 profile/history integrations remain upstream work.
- **J:** Owns Phase 13 federation; H does not merge `track/j-federation`.
- **Phase 10 external work:** A still owns profile message-history links, verified-phone consent, `athleteChatEnabled`, and conversation synchronization; C owns chat attachment authorization; G owns schedule-change coalescing.
