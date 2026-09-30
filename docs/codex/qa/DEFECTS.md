# QA Defects

## Open

### QA-ACC-033 — Federation navigation needed a reachable browser assertion

- **Owner:** Track C (wiring; coordinate with Track J)
- **Phase:** 13, required journey 25
- **Evidence:** The current trunk `5cdee29e` aggregates `federationConsoleNav` in `web/src/console/nav.ts`; the nav descriptor requires `federation.read`. The regression had asserted only that the link was visible, without following it.
- **Reproduce:** sign in as an organization with federation access, open its console home, and follow the Federation item.
- **Expected:** eligible league/association and member-club users can reach Federation through the normal console navigation, with visibility scoped to the `federation.read` permission.
- **Request:** none for the navigation implementation. QA now clicks the permission-gated link and asserts the federation route and page heading in `e2e/federation.spec.ts`.
- **Status:** navigation wiring is present on current trunk; the strengthened QA browser assertion awaits exact-head CI.

### QA-ACC-034 — Ending a relationship has no read-revocation regression

- **Owner:** Track J
- **Phase:** 13 acceptance criterion 3
- **Evidence:** `server/test/federation.test.ts` verifies an invite/accept/share/suspend/resume/end lifecycle and the ended status/audit row, but does not attempt a privileged cross-org read after ending. A separate test verifies denial only for a suspended relationship.
- **Reproduce:** inspect the lifecycle test and search the federation test suite for `endRelationship` followed by a cross-org roster/team/compliance read; no such assertion exists.
- **Expected:** after one side ends an active relationship, previously permitted reads from either side fail immediately with 404 and return no other-org data.
- **Request:** add a real-Postgres regression that ends an active relationship and asserts previously shared cross-org reads are denied immediately.
- **Status:** open acceptance evidence gap; the current implementation has active-relationship checks, but end-state revocation is not directly tested.

### QA-SEC-007 — Two-party federation RLS policies lack outsider-denial coverage

- **Owner:** Track J
- **Phase:** 13 acceptance criterion 1
- **Evidence:** `org_relationships` and `federation_event_links` use explicit RLS policies because they have no single `org_id`; the generic `server/src/db/withOrg.test.ts` inventory covers tables with `org_id` and its cross-org row test exercises `idempotency_keys`, not an unrelated third organization against these two-party tables. Federation tests do not include a third-party RLS denial assertion.
- **Reproduce:** inspect `db/migrations/6000_federation.sql`, `server/src/db/withOrg.test.ts`, and `server/test/federation.test.ts`; no test attempts to read or mutate a league/club relationship or event link while scoped to an unrelated organization.
- **Expected:** a third organization cannot read or write either two-party row, while the two participating organizations retain only their policy-authorized visibility.
- **Request:** add a real-Postgres RLS regression for both explicit two-party policies using an unrelated third organization.
- **Status:** open security acceptance evidence gap; the migration defines explicit RLS policies, but outsider denial is not directly tested.

### QA-SEC-008 — Federation compliance sharing has no status-only privacy regression

- **Owner:** Track J
- **Phase:** 13 task 3 and acceptance criterion 1
- **Evidence:** `server/src/modules/federation/directory.ts` exposes `readMemberCompliance`; `associationDashboard` can reach it indirectly through the member summary, but no federation test directly asserts its fields, denial behavior, or audit rows. Existing tests cover allow-listed roster fields and dual-org audit for other cross-org reads, not the compliance status-only response.
- **Reproduce:** search the federation integration suite for a direct `readMemberCompliance` assertion; none checks its response keys, denied state when `compliance_status` is false, or dual-org audit when it is true.
- **Expected:** with `compliance_status` shared, a league receives only permitted staff identity/role/team labels and derived credential states—never document IDs/content, notes, or medical data—and the read is audited in both orgs; without the sharing key, it receives 422 `FEDERATION_SHARING_DENIED` with no data.
- **Request:** add a real-Postgres test for the allowed response fields, denied-sharing case, and audit rows in both organizations.
- **Status:** open security acceptance evidence gap; indirect dashboard coverage does not establish the service's privacy or audit contract.

### QA-ACC-035 — Federation sharing trigger rejects the API's snake_case keys

- **Owner:** Track J
- **Phase:** 13 tasks 1–3 and acceptance
- **Evidence:** `shared/src/schemas/federation.ts` and the service store `compliance_status` and `team_entries`, but `federation_sharing_guard()` in `db/migrations/6000_federation.sql` allows `complianceStatus` and `teamEntries`. Accepting a relationship copies the stored proposal into `data_sharing`, where the trigger validates it and should reject those keys.
- **Reproduce:** create or accept a federation relationship with `{ team_entries: true }` or `{ compliance_status: true }`; the database trigger's allow-list does not contain those persisted JSON keys. Existing federation tests use these values, but the QA stack could not run them because Track I occupies port 6932.
- **Expected:** all four schema-approved keys (`rosters`, `compliance_status`, `team_entries`, `discipline`) can be proposed, accepted, persisted, and read back without a trigger error; other keys remain rejected.
- **Request:** add an additive migration that corrects the trigger allow-list to the shared schema's persisted key names, preserving the already-applied `6000_federation.sql`, and add a real-Postgres regression covering all allowed keys.
- **Status:** high-confidence static runtime blocker; database execution remains unverified until the QA stack can start.

### QA-ACC-036 — Federation journey does not prove both clubs' field windows affect the schedule

- **Owner:** Track J
- **Phase:** 13 acceptance criterion 2, required journey 25
- **Evidence:** `e2e/federation.spec.ts` contributes one field window from each club, but seeds one team per club and only asserts one generated game with zero unscheduled. `FederationConsole` hardcodes `rounds: 1`, so the observed game can use at most one club's field and the assertion does not detect if the other club's contribution is ignored.
- **Reproduce:** inspect the fixture and the `Generate schedule draft` handler; no assertion identifies scheduled events by both member-club spaces.
- **Expected:** the acceptance test demonstrates that both member clubs' availability is included in generation and that generated games can be placed on each club's contributed field.
- **Request:** extend the deterministic schedule fixture to produce enough games and assert output references field windows from both clubs, or add an equivalent test that directly verifies the merged generator input.
- **Status:** open acceptance coverage gap; the existing one-game journey has not been executed on the QA stack.

### QA-ACC-037 — Donation acceptance flow is authenticated instead of guest

- **Owner:** Track H
- **Phase:** 11 acceptance criterion 3
- **Evidence:** `e2e/phase11.spec.ts` signs in the actor before configuring nonprofit acknowledgment settings, then navigates to the public fundraiser and completes the $300 donation in the same browser context. The session cookie remains active, so this does not verify guest checkout.
- **Reproduce:** inspect the donation acceptance test; `signInBrowser(page, ...)` runs before `/console/orgs/:orgId/fundraising`, and no sign-out, cookie removal, or anonymous browser context is used before submitting the donation.
- **Expected:** an unauthenticated visitor can donate $300 to a team campaign and receive the required nonprofit acknowledgment email while the public campaign total updates.
- **Request:** keep the authenticated setup for nonprofit settings, then use a fresh anonymous browser context (or clear the session cookie) for public donation and assert the context has no session before checkout.
- **Status:** open acceptance gap; the existing scenario may still exercise the payment route but does not prove guest access.

### QA-SEC-009 — Scoped organization members can read unrelated household volunteer ledgers

- **Owner:** Track H
- **Phase:** 11; privacy/permission model in `docs/codex/04-PERMISSIONS-AND-PRIVACY.md`
- **Evidence:** `householdVolunteerLedger()` authorizes any active `org_memberships` row or verified guardian link. The route has no role/scope check. Organization invitations can create active memberships with program-scoped roles; `orgActor()` reports no org-wide role for those users, but the ledger service still grants access to every household ID in the organization.
- **Reproduce:** an active program-scoped `director` requests `/api/v1/volunteers/orgs/:orgId/households/:householdId/ledger` for a household outside their volunteer relationship. `e2e/security/volunteer-household-ledger.spec.ts` now actively asserts the expected 404; current code returns the household ledger.
- **Expected:** only a verified guardian of that household or a role with organization-wide volunteer oversight can read the ledger; unrelated and out-of-scope members receive 404 with no household data.
- **Request:** replace the broad active-membership check with explicit owner/admin/volunteer-coordinator authorization (including the applicable scope policy) or verified guardian access, and add an integration regression for a program-scoped director.
- **Status:** runtime-confirmed on the isolated QA Chromium run at trunk snapshot `d52e4c83`: a program-scoped director received HTTP 200 and another household's volunteer ledger. The active regression expects the scoped member to receive 404.

### QA-ACC-038 — Family uniform orders are not linked to team/program size reports

- **Owner:** Track H (coordinate registration add-on checkout with Track E)
- **Phase:** 11 acceptance criterion 4
- **Evidence:** the family `StorePortal.placeOrder()` sends `householdId`, fulfillment, and line `personId`, but no `registrationId` or `teamSeasonId`. `placeStoreOrder()` stores those omitted fields as null, while `uniformSizeReport()` filters/group rows using `store_order_lines.registration_id` and `team_season_id`. The existing report integration test manually supplies both IDs to `placeStoreOrder()`, so it bypasses the family portal contract. The service also trusts a caller-supplied team season without checking its relationship to the household member or registration.
- **Reproduce:** place and pay for a uniform as a family through `/me/orgs/:orgId/store`, then query the report for the athlete's program/team. The portal order has no team or registration association and does not appear in the team's report; supplying another valid team-season UUID directly can instead misattribute it.
- **Expected:** a paid uniform selection for a registered athlete is attributed to that athlete's verified registration and team, and callers cannot attach purchases to unrelated teams; report totals match actual family selections.
- **Request:** wire the registration add-on and family store flows to derive or validate registration/team attribution from the selected household member, reject mismatched team IDs, and add a browser regression that pays for a family uniform and verifies the team/program report.
- **Status:** fixed on `fix/d`: the family store loads the caller's active registrations, selects the unique registration for the selected athlete by default, and submits that ID; the service validates household, person-link, and team consistency and persists the registration's team on the order lines. The targeted store service test passes 8/8, the StorePortal selection/payload component test passes 2/2, and the hosted browser journey is absent from the failing-test list in run `36680761860` on `2b1ceb68`. The overall E2E job was red on unrelated tests.

### QA-ACC-039 — Concurrent volunteer buyouts can leave an extra payable invoice

- **Owner:** Track H
- **Phase:** 11 volunteer buyout and financial correctness
- **Evidence:** `buyOutVolunteerRequirement()` issues the invoice before acquiring the requirement row lock and recomputing the household ledger. If concurrent requests with different idempotency keys compete for the final remaining units, the first records its buyout; the second detects the reduced balance and returns a conflict only after its invoice has already been issued. The late failure path does not cancel or void that invoice.
- **Reproduce:** with one buyout unit remaining, concurrently call the service twice for one unit using distinct creation keys. One call succeeds; the other rejects after issuing an invoice. `e2e/phase11-buyout-race.spec.ts` now actively asserts that only one buyout invoice line may persist.
- **Expected:** the losing request leaves no payable invoice or invoice line; buyout reservation and invoice creation must remain consistent under concurrency.
- **Request:** reserve/decrement remaining units before issuing the invoice, or compensate by voiding the invoice if the locked recheck fails; add a Postgres concurrency regression that asserts the losing request creates no invoice.
- **Status:** fixed on `fix/d`: buyout requests serialize by org/requirement/household/person, and the household ledger now counts existing buyout rows independently of volunteer signups. The targeted PostgreSQL test passes 3/3 and verifies one success, one conflict, one buyout, and one invoice line. The hosted browser journey is absent from the failing-test list in run `36680761860` on `2b1ceb68`; the overall E2E job was red on unrelated tests.

### QA-ACC-040 — Volunteer coach-count setting does not affect household progress

- **Owner:** Track H
- **Phase:** 11 task 1
- **Evidence:** `createVolunteerRequirement()` stores `counts_coach_roles` and `listVolunteerRequirements()` returns it, but `householdVolunteerLedger()` calculates completed units only from `volunteer_signups` with `status = 'completed'`. No ledger query joins active coach/team-parent assignments.
- **Reproduce:** create a requirement with `countsCoachRoles: true`, assign a household member an active coach/team-parent role for a registered team, and read the household ledger; the coach role contributes no completed units.
- **Expected:** when enabled, qualifying coach/team-parent service is included in the household or athlete requirement according to the configured scope; when disabled, it is excluded.
- **Request:** include eligible team staff roles in requirement progress only when `countsCoachRoles` is true, and add real-Postgres tests for both setting values.
- **Status:** open Phase 11 behavior gap; source review found no counting path, but database execution is pending the isolated QA stack.

### QA-ACC-041 — Volunteer shortfall invoice settings are stored but never enforced

- **Owner:** Track H
- **Phase:** 11 task 1
- **Evidence:** volunteer requirements persist and return `auto_invoice_shortfall` and `notice_days`, but `server/src/modules/volunteers/module.ts` registers no jobs and no production code reads those values to notify households or issue shortfall invoices.
- **Reproduce:** create a requirement with `autoInvoiceShortfall: true` and a nonzero `noticeDays`, leave a household short, and inspect registered jobs and service call sites; no notice or invoice enforcement path exists.
- **Expected:** with the default-off setting enabled, affected households receive the configured advance notice and an invoice for the remaining buyout shortfall at the deadline; disabled requirements create no automatic invoice.
- **Request:** add an idempotent scheduled enforcement job that honors `noticeDays`, `autoInvoiceShortfall`, current credits, and buyout prices, with fake-clock and duplicate-run integration tests.
- **Status:** open Phase 11 behavior gap; the configuration is currently inert.

### QA-ACC-042 — Volunteer shifts have no event-block generation or reminder job

- **Owner:** Track H
- **Phase:** 11 task 1
- **Evidence:** the only shift creation path inserts one `volunteer_shifts` row at a time; `event_id` is optional metadata and the volunteer module registers `jobs: []`. The shift-reminder template is declared but no service schedules or emits it.
- **Reproduce:** inspect `createVolunteerShift()` and the volunteer module job registry; there is no event-block expansion or 24-hour reminder producer.
- **Expected:** coordinators can generate shifts from a selected event block or series and signed-up households receive the shift reminder through the configured preview/provider adapters.
- **Request:** implement event-based shift generation and a deduplicated reminder job; test that a multi-event block produces the expected shifts and only due signups receive a reminder.
- **Status:** open Phase 11 task gap; no generation or reminder execution path is present.

### QA-ACC-043 — Store fulfillment updates do not notify the purchaser

- **Owner:** Track H (coordinate notification catalog registration with Track B)
- **Phase:** 11 task 5
- **Evidence:** `updateFulfillment()` changes fulfillment and order status but never creates an order-update notification. `store.order_update` is declared by the module but has no delivery call from fulfillment transitions; the H track note also records the central notification catalog dependency as outstanding.
- **Reproduce:** mark a paid ship order `shipped` or a pickup order `ready`; the service response and database state change, but no notification is enqueued for `store_orders.account_id`.
- **Expected:** the purchaser receives an order-status notification after meaningful fulfillment transitions, with no message for stale or rejected updates.
- **Request:** register the notification type/template and enqueue a deduplicated purchaser notification from the successful fulfillment transaction; add an integration assertion using the notification outbox.
- **Status:** open Phase 11 behavior gap; static service review found no notification call.

### QA-ACC-044 — Production guest donations have no checkout provider

- **Owner:** Tracks H/E/C (fundraising route, payment adapter, and production wiring)
- **Phase:** 11 acceptance criterion 3
- **Evidence:** `server/src/modules/fundraising/routes.ts` selects `PreviewGuestDonationCheckout` only outside production. In production, it uses `dependencies.donationCheckout`, but the generated `ServerModule` router contract accepts only `AuthDependencies`, `createFundraisingRouter` is registered directly in `fundraising/module.ts`, and no `donationCheckout` provider or production adapter exists elsewhere in `server/src`. A valid public donation therefore returns `503 CHECKOUT_UNAVAILABLE` before creating a checkout.
- **Reproduce:** configure a published campaign in a production-mode deployment and submit a valid, Turnstile-verified guest donation with an `Idempotency-Key`. The handler responds `503` because `donationCheckout` is undefined. The preview adapter succeeds only in non-production.
- **Expected:** a production donation creates a test-mode hosted checkout for the organization's connected account, and signed payment-completion/failure events settle the donation and deliver the receipt exactly once. Do not use live Stripe keys or real payments during implementation or tests.
- **Request:** H should extend its fundraising route/module contract to accept the payment boundary; E should provide the test-mode connected-account checkout adapter and settle/receipt callbacks; C should inject that adapter through module wiring and route signed callbacks through the existing Stripe webhook dispatcher. Add a regression using a fake provider and signed synthetic webhook payloads.
- **Status:** open Phase 11 launch blocker; source inspection confirms production returns 503, while the database/browser reproduction awaits the isolated QA stack.

### QA-ACC-045 — Sponsor renewal reminders are disabled by the missing catalog type

- **Owner:** Tracks H and B
- **Phase:** 11 task 4 (sponsor renewal reminders)
- **Evidence:** This was true on the earlier trunk snapshot: the job's catalog guard returned `{ notified: 0 }` when `sponsor.renewal_reminder` was missing. Current `rebuild/trunk` `5cdee29e` registers the notification type in both the catalog and sponsors module. The QA branch adds `e2e/phase11-sponsor-renewal.spec.ts`, which runs the job twice and asserts one persisted reminder.
- **Reproduce:** create an active sponsor whose contract ends within the 30-day renewal window, run `runSponsorRenewalJob()`, and inspect the owner's notifications; the guard returns before querying organizations and no reminder is inserted. `e2e/phase11-sponsor-renewal.spec.ts` now actively asserts the expected notification.
- **Expected:** a single idempotent renewal reminder is inserted for each applicable owner/admin/finance recipient, and repeat daily job runs do not duplicate it.
- **Request:** Re-run the renewal acceptance test against the current integrated head and keep its duplicate-run assertion.
- **Status:** implementation is present on current trunk; QA branch browser/database verification is pending its exact-head CI result.

### QA-SEC-010 — Revoked guardians retain access to class waitlist entries

- **Owner:** Track I
- **Phase:** 12; guardian access revocation and household privacy
- **Evidence:** `/me/waitlist` calls `waitlistForAccount()` with only the signed-in account ID, which returns waitlist entries without checking whether the linked guardian/self relationship is still verified and active. The accept/decline routes also rely on the stored `entry.account_id`; waitlist creation can outlive a later link revocation. `e2e/security/class-waitlist-revoked-guardian.spec.ts` now actively asserts the expected no-data response.
- **Reproduce:** create an offered class waitlist entry for a verified guardian account, revoke its `person_account_links` row, then GET `/api/v1/classes/orgs/:orgId/me/waitlist`; the current query still returns the child's name and entry identifiers.
- **Expected:** revoking the link immediately removes access to that child's waitlist data and blocks accepting or declining its offer; the response must contain no child or waitlist identifiers.
- **Request:** revalidate active verified self/guardian access for every child-specific waitlist list/read/mutation, including `waitlistForAccount()`, accept and decline; add a real-Postgres regression for link revocation after offer creation.
- **Status:** runtime-confirmed in the isolated QA Chromium run at trunk snapshot `d52e4c83`: after guardian-link revocation, the waitlist endpoint returned two entries.

### QA-SEC-011 — Class portal booking actions bypass household ownership

- **Owner:** Track I
- **Phase:** 12; class portal privacy and authorization
- **Evidence:** `GET /me/punch-cards` filters by the stored purchaser account but does not require an active verified link to the card's person. `POST /me/bookings/:bookingId/cancel` and `POST /me/punch-cards/:punchCardId/book` require only active organization membership; `cancelBooking()` and `bookPunchCard()` select records by organization and ID without checking the actor, purchaser, or an active guardian/self link.
- **Reproduce:** revoke the purchaser's guardian link after a child receives a punch card and booked class session. The former guardian still sees the card; any other active organization member who knows the booking or card UUID can cancel the booking or consume a punch.
- **Expected:** private class cards are hidden and member portal actions are denied unless the caller is the current verified guardian/self for the person and is authorized for the purchaser-owned record; denied calls leave bookings and remaining punches unchanged.
- **Request:** enforce current person-link and account ownership in the portal list, booking-cancel and punch-redemption paths (retaining separate authorized staff actions); add a real-Postgres regression asserting 404/no data and no mutation for a revoked guardian and unrelated active member.
- **Status:** runtime-confirmed in the isolated QA Chromium run at trunk snapshot `d52e4c83`: a revoked guardian still received the child's punch-card listing, and a forged same-organization household booking returned 201 and persisted under the unrelated household.

### QA-SEC-012 — League entry reads ignore revoked roster-sharing permission

- **Owner:** Track J
- **Phase:** 13; federation roster privacy and immediate sharing revocation
- **Evidence:** `GET /organizations/:orgId/entries` calls `listLeagueEntries()`, which loads stored roster snapshots without checking the current relationship or `rosters` key; `GET /organizations/:orgId/entries/:entryId` calls `getLeagueEntry()` and returns all snapshot player fields without either check. `GET /organizations/:orgId/members/:memberOrgId/teams` calls `readMemberTeams()`, which requires only `team_entries` sharing but returns `rosterSize` from the snapshot even when `rosters` is not shared. The child side can immediately revoke `rosters` while retaining `team_entries`, but all three reads continue exposing roster-derived data. `e2e/security/federation-sharing-revocation.spec.ts` now actively asserts redaction.
- **Reproduce:** accept a relationship with `{ rosters: true, team_entries: true }`, submit and accept a team entry, then have the member club revoke `rosters` while leaving `team_entries` enabled. As a league user, GET `/api/v1/federation/organizations/:leagueOrgId/entries`, `/entries/:entryId`, and `/members/:memberOrgId/teams`; the current implementation returns `snapshot.playerCount`, the full roster (including player names and person references), and per-team `rosterSize`.
- **Expected:** each response re-evaluates the current active relationship and sharing keys. Keep team-entry metadata when `team_entries` remains enabled, but omit roster-derived counts and player fields after `rosters` is revoked. Suspension or ending the relationship must stop the league from reading the stored roster immediately.
- **Request:** update `listLeagueEntries()`, `getLeagueEntry()`, and `readMemberTeams()` to gate cached snapshot fields on the current relationship status and `rosters` grant; add real-Postgres/API coverage for child-side immediate revocation and relationship suspension/end.
- **Status:** runtime-confirmed in the isolated QA Chromium run at trunk snapshot `d52e4c83`: roster-derived counts remained in the league response after the child organization revoked `rosters` sharing.

### QA-SEC-013 — Class browse infers an unlinked child's age band

- **Owner:** Track I
- **Phase:** 12; academy portal privacy
- **Evidence:** `GET /orgs/:orgId/me/browse` accepts an optional `personId`, requires only active organization membership, and passes the ID to `PostgresClassEnrollments.browse()`. The service reads that person's date of birth and returns only class offerings whose age bounds match, without verifying a current verified self/guardian link. Because `BrowseClass` exposes the age bounds, an unrelated member can infer which age band the child falls into. `e2e/security/class-browse-person-link.spec.ts` now actively asserts the expected authorization denial.
- **Reproduce:** create several published age-banded classes and a child with a known ID but no active `person_account_links` row for the caller. As a different active organization member, request `/api/v1/classes/orgs/:orgId/me/browse?personId=:childId`; the current route returns offerings filtered using the child's DOB.
- **Expected:** a supplied `personId` is accepted only when the signed-in account has a current verified self/guardian link; otherwise return the standard authorization denial without age-filtered results.
- **Request:** call `requireLinkedPerson()` before passing `personId` from `/me/browse` into the service and add the real-Postgres/API regression in the new security spec.
- **Status:** runtime-confirmed in the isolated QA Chromium run at trunk snapshot `d52e4c83`: an unlinked same-organization member received HTTP 200 and age-filtered class results for the child's person ID.

### QA-SEC-014 — A guardian of an instructor inherits session-roster access

- **Owner:** Track I
- **Phase:** 12; academy roster privacy
- **Evidence:** `GET /orgs/:orgId/sessions/:sessionId/roster` authorizes through `requireSessionStaffOrInstructor()`. Its instructor branch joins an active `class_instructors` row to any `person_account_links` row for that person/account pair, checking only `revoked_at IS NULL`; it does not require a verified `self` link. The route does not require organization membership before this branch. A guardian with a still-active link to an assigned adult instructor therefore passes authorization without being the instructor or class staff. `sessions.roster()` then returns attendee names and person IDs. The active regression in `e2e/security/class-instructor-guardian-roster.spec.ts` asserts the expected 403 and absence of student names.
- **Reproduce:** assign an adult instructor person to an active class schedule; retain a verified guardian link from a separate, non-member account to that person; create a booked student session; GET `/api/v1/classes/orgs/:orgId/sessions/:sessionId/roster` with the guardian's session. The current instructor predicate treats the guardian link as the instructor's own link and returns the roster.
- **Expected:** only the assigned instructor account itself, authenticated through its current verified self link, or authorized class staff can read the session roster. A guardian link to the instructor person alone must not grant access; return 403/404 with no roster or attendee details.
- **Request:** require a verified active self relationship (or an equally explicit account-to-instructor authorization) when authorizing session instructors; do not let guardian relationships inherit the instructor's roster permission. Add a real-Postgres/API regression for an adult instructor with a separate linked guardian account.
- **Status:** runtime-confirmed in the isolated QA Chromium run at trunk snapshot `d52e4c83`: a non-member guardian linked to the instructor person received HTTP 200 and the session roster.

### QA-ACC-046 — Rejected federation invoice void leaves the assessment marked void

- **Owner:** Track J
- **Phase:** 13; federation fee cancellation and financial correctness
- **Evidence:** `voidFeeAssessment()` commits `federation_fee_assessments.status = 'void'` in one transaction, then calls `PostgresInvoiceRepository.void()` in another. The finance service rejects voids when an invoice has an active installment, net payment, credit, or dispute; on that rejection, the assessment remains void while its invoice remains payable. `e2e/phase13-fee-void-atomicity.spec.ts` now actively asserts the active-installment case.
- **Reproduce:** issue a league fee invoice to a member-club payer, add a scheduled installment to that invoice, and POST the fee assessment void action. QA observed HTTP 500; a subsequent read showed `assessment.status='void'`, `invoice.status='open'`, and `balance_cents=2500`.
- **Expected:** a rejected invoice void leaves the fee assessment in `invoiced` state and preserves the payable invoice state; successful voids update both records consistently.
- **Request:** reorder or transact the assessment and invoice state changes so failed invoice validation cannot commit an assessment void; add real-Postgres regression coverage for active installments and net paid balances.
- **Status:** runtime-confirmed on the isolated QA stack: the request returned HTTP 500 and committed the assessment as void while leaving its invoice open with the full 2500-cent balance. The active regression expects rejection with both records unchanged.

### QA-OPS-001 — Render health probes have no `/readyz` handler and public status is missing

- **Owner:** Track C
- **Phase:** 16 §4.1 and §4.4
- **Evidence:** `render.yaml` sets `healthCheckPath: /readyz`, but no `/readyz` route is registered; the required public `/status` route is also absent.
- **Reproduce:** inspect the Render web service and search `server/src` for `/readyz` and a public `/status` handler; the health path is configuration-only and platform `/orgs/:orgId/status` is a separate authenticated mutation.
- **Expected:** `/readyz` reports readiness for the web service, and `/status` exposes only non-sensitive service state publicly.
- **Request:** implement/register both endpoints and add HTTP tests for ready/unready and public redaction behavior.
- **Status:** open launch blocker; configured production health checks currently target a missing route.

### QA-OPS-002 — Required key-generation npm scripts are missing

- **Owner:** Track C
- **Phase:** 16 §4.7
- **Evidence:** `scripts/keys-generate.ts` and `scripts/keys-vapid.ts` exist, but `package.json` defines neither `keys:generate` nor `keys:vapid`.
- **Reproduce:** inspect `package.json` scripts; both required commands are absent.
- **Expected:** operators can invoke `npm run keys:generate` and `npm run keys:vapid`, with safe owner-only output files and no key material in logs.
- **Request:** register the scripts and retain the existing file-permission protections.
- **Status:** open operator-tooling acceptance gap.

### QA-OPS-003 — Operational alert rules are not wired to a runtime check

- **Owner:** Track C
- **Phase:** 16 §4.3
- **Evidence:** `evaluateOperationalAlerts`, `captureOperationalAlert`, and `writeStructuredLog` are unused in production code; Knip reports the latter two as unused exports. Their unit tests do not schedule metric collection or deliver alerts.
- **Reproduce:** search non-test `server/src` for calls to those functions; only their definitions are present.
- **Expected:** periodic checks collect worker, queue, webhook, payment-failure, and email-bounce metrics and deliver redacted alerts through the configured sink.
- **Request:** wire the operational check/sink and structured logger in web and worker startup, with an integration test proving a synthetic alert reaches the fake sink.
- **Status:** open reliability acceptance gap.

### QA-OPS-004 — Web runtime receives `DATABASE_ADMIN_URL`

- **Owner:** Track C
- **Phase:** 16 §4.3
- **Evidence:** `render.yaml` supplies `DATABASE_ADMIN_URL` to the web service even though it is needed for pre-deploy migrations; OPS has an explicit request to remove it from web runtime after pre-deploy.
- **Reproduce:** inspect the `athlentry-web` environment variables in `render.yaml`.
- **Expected:** the privileged database URL is available to the pre-deploy migration command and absent from the running web process.
- **Request:** scope the admin URL to pre-deploy only and verify the web service starts without it.
- **Status:** open least-privilege deployment gap.

### QA-OPS-005 — Restore-drill cleanup stops when scratch database removal fails

- **Owner:** Track OPS
- **Phase:** 16 §4.2 restore verification
- **Evidence:** in `scripts/restore-drill.ts`, the `finally` block awaits `DROP DATABASE` before `adminClient.end()` and `rm(tempDirectory)`. If the drop query rejects, control leaves the cleanup block before the maintenance connection and encrypted temp backup are cleaned up.
- **Reproduce:** inject a failure for the scratch `DROP DATABASE` query after backup creation and restore; observe that the temp directory removal and explicit maintenance-client close are not reached.
- **Expected:** every cleanup action is attempted independently on success and failure paths. A failed scratch drop remains visible to the operator, while the temp backup is removed and the maintenance connection is closed; any remaining scratch database is identified for retry/cleanup.
- **Request:** structure cleanup with nested `try/finally` (or an equivalent all-actions cleanup helper), preserve the primary/cleanup errors, and add a failure-injection test that asserts temp-file removal and connection closure still run when the scratch drop fails.
- **Status:** high-confidence static reliability finding; failure-path behavior not executed on QA's isolated Postgres stack.

### QA-SEC-001 — Route permission and tenancy metadata is not integrated on trunk

- **Owner:** Track C
- **Phase:** 16 §1.2
- **Evidence:** current `rebuild/trunk` `5cdee29e` has no `x-athlentry-permission`, `x-athlentry-resource`, or `x-athlentry-scope` operation metadata and an empty `operations` map in `server/test/security/permission-matrix.json`. The current local Track C branch contains 808 metadata-bearing OpenAPI operations and 808 permission rows across 23 roles, but it is not integrated. The tenancy-fuzz quality gap is tracked separately in QA-SEC-016.
- **Reproduce:** compare `git show rebuild/trunk:server/test/security/permission-matrix.json` with `git show track/c-adapters:server/test/security/permission-matrix.json`, and inspect generated OpenAPI metadata at both refs.
- **Expected:** integrate the generated metadata and complete role matrix, then run the route-authorization, permission-matrix, and tenant-fuzz checks on the integrated trunk.
- **Request:** integrate the implementation and re-run the metadata/matrix suites on trunk. Keep QA-SEC-016 open until its resource-ID controls and method coverage are complete.
- **Status:** open for trunk integration and verification on `5cdee29e`; rerun the active security checks after C's route-contract change lands.

### QA-SEC-002 — Security-header browser check omits production HSTS coverage

- **Owner:** Track C
- **Phase:** 16 §1.4
- **Evidence:** `e2e/security/security-headers.spec.ts` checks CSP, framing, content-type, referrer and permissions headers only on `/healthz`. It does not assert production-only HSTS or check an API/static response; `server/src/lib/security/security-headers.test.ts` covers production HSTS only at middleware-unit level.
- **Reproduce:** inspect the browser spec's sole `/healthz` request and compare its assertions with the Phase 16 §1.4 requirement for production HSTS and relevant response types.
- **Expected:** browser acceptance asserts HSTS in a production-configured response and checks the shared header policy on representative API and static responses, while preserving the explicit embed framing exception.
- **Request:** add a production-configured browser assertion for HSTS and verify the common headers across representative mounted response types.
- **Status:** open browser-coverage gap. A prior Chromium run passed the current `/healthz` assertions; production HSTS and API/static response coverage remain unasserted.

### QA-SEC-003 — CI has no Gitleaks secret scan

- **Owner:** Track C
- **Phase:** 16 §1.3
- **Evidence:** trunk `.github/workflows/ci.yml` now has a `secret-scan` job using the Gitleaks action on pull requests and pushes to `main`/`rebuild/**`.
- **Reproduce:** compare the CI workflow on `rebuild/trunk` and `track/c-adapters`; the scan is present only on the C branch.
- **Expected:** CI scans the repository with Gitleaks and fails on detected secrets without printing secret values.
- **Request:** verify the workflow on a clean repository state and confirm hosted CI execution.
- **Status:** implementation integrated at `d52e4c83`; the local source assertion passed in the prior QA run. Hosted GitHub Action execution remains unverified from this workspace.

### QA-SEC-004 — Web Push accepts internal network endpoints

- **Owner:** Track C
- **Phase:** 16 §1, SSRF protection
- **Evidence:** trunk now validates supported provider hosts and public DNS answers, then pins delivery to the vetted address before sending Web Push.
- **Reproduce:** on current trunk, instantiate `WebPushSender` with a fake transport and call `send` with `https://127.0.0.1:443/latest/meta-data`; the endpoint is passed to `sendNotification`. Compare with the C branch implementation.
- **Expected:** loopback, private, link-local, and non-provider destinations are rejected before transport, with DNS resolution protected from rebinding.
- **Request:** keep synthetic tests proving private destinations are rejected before transport and DNS rebinding is prevented; no live request is needed.
- **Status:** fixed at `d52e4c83`; sender unit coverage and the Chromium loopback/private-destination regression passed in the prior QA run.

### QA-SEC-005 — Step-up reauthentication does not rotate the session

- **Owner:** Track A
- **Phase:** 16 §1.5
- **Evidence:** trunk now rotates the password/TOTP step-up session, returns a replacement cookie or bearer token, and revokes the old token.
- **Reproduce:** compare the step-up route at `rebuild/trunk` and `track/a-core`, then run `e2e/security/session-step-up-fixation.spec.ts` against the isolated stack.
- **Expected:** successful step-up rotates the session token, sends the replacement cookie with the required flags, and revokes the prior session token.
- **Request:** retain the active cookie and bearer regressions on trunk.
- **Status:** fixed at `d52e4c83`; the active cookie and bearer fixation regression passed in the prior Chromium run.

### QA-SEC-006 — CI has no SQL raw-interpolation guard

- **Owner:** Track C
- **Phase:** 16 §1.2
- **Evidence:** `.github/workflows/ci.yml` has no guard for interpolated `sql.raw` usage, although Phase 16 requires a CI check. No `sql.raw` call is currently present in `server/src` or `shared/src`.
- **Reproduce:** search the workflow and CI scripts for `sql.raw`; no check is defined.
- **Expected:** CI fails on `sql.raw` that incorporates interpolated or user-controlled input while allowing any explicitly reviewed static fragments.
- **Request:** add the source guard and a fixture test proving an unsafe interpolated use fails.
- **Status:** open security acceptance gap; no vulnerable `sql.raw` call was found in the current source.

### QA-ACC-002 — Guardian medical journey awaits browser verification

- **Owner:** Track A
- **Phase:** 2, required journey 2
- **Evidence:** upstream `2ac58d6` landed the medical flow and updated `e2e/guardian-invitation.spec.ts` to save allergy, medication and emergency-contact data. QA added saved-value assertions after reload and extended `e2e/security/guardian-idor.spec.ts` to assert that another guardian receives 404 for the medical profile.
- **Reproduce:** run `e2e/guardian-invitation.spec.ts` and `e2e/security/guardian-idor.spec.ts` against the isolated QA stack.
- **Expected:** accepted guardians can update and reload the child's medical data; an unlinked guardian cannot read it.
- **Request:** none; coverage is added on `track/qa`.
- **Status:** browser verification pending because Track I owns the QA Postgres port.

### QA-ACC-003 — Import acceptance does not exercise the required 2,000-row batch

- **Owner:** Track A
- **Phase:** 2, required journey 3
- **Evidence:** trunk `e2e/people-import.spec.ts` previews and rolls back a two-row file. QA added `e2e/journeys/import-scale.spec.ts` to exercise the specified 2,000-person batch and verify all rows are archived after rollback.
- **Reproduce:** run `e2e/journeys/import-scale.spec.ts` against the isolated QA stack.
- **Expected:** the full 2,000-row preview reports all records to create, commit succeeds, rollback marks all records archived, and axe reports no violations.
- **Request:** none; scale coverage is added on `track/qa`.
- **Status:** browser verification pending because Track I owns the QA Postgres port.

### QA-ACC-015 — Schedule generation-to-publication journey is missing

- **Owner:** Track G
- **Phase:** 8, required journey 15
- **Evidence:** `e2e/schedule-generator.spec.ts` now exercises generation, explanation review, discard and apply, but it stops before publication and family notification. Track G reports that its change batches emit through Track B's notification service, which currently marks only `in_app`; the required preview/Mailpit family notice is not evidenced.
- **Reproduce:** run `e2e/schedule-generator.spec.ts`; the flow ends after apply and reads the generated events directly from the database. It does not publish them or assert any family delivery.
- **Expected:** a desktop and iPhone-width browser flow generates a schedule, reviews and applies it, publishes it, and verifies family notification delivery through the preview/Mailpit adapter, with axe checks.
- **Request:** extend the existing browser journey through event publication and family notification. Coordinate the notification channel work with B/C and verify delivery through the preview/Mailpit adapter, including axe checks.
- **Status:** partial coverage added on the latest trunk; publication and family notification remain open. Browser execution is pending the isolated QA stack.

### QA-ACC-016 — Rainout journey omits notification and reschedule approval

- **Owner:** Track G
- **Phase:** 8, required journey 16
- **Evidence:** `e2e/schedule-stats.spec.ts` closes a facility and checks that an affected event is postponed; it does not assert notification delivery or an approved reschedule request.
- **Reproduce:** run the schedule statistics journey and inspect the closure flow; it ends after the event status changes.
- **Expected:** affected families receive the preview/Mailpit notice, a reschedule request is submitted, and staff approves it through the browser flow.
- **Request:** extend or add the rainout acceptance journey through notice delivery and approved rescheduling, with axe checks.
- **Status:** open coverage gap; no product defect established.

### QA-ACC-017 — Offline game-day journey omits lineup warning and successful score sync

- **Owner:** Track G
- **Phase:** 9, required journey 17
- **Evidence:** `e2e/schedule-offline.spec.ts` verifies offline attendance sync and preserves a conflicting score in the queue; it does not exercise a lineup minimum-play warning or a successful score sync.
- **Reproduce:** run the offline game-day journey; it deliberately creates a version conflict before score synchronization and never opens a lineup.
- **Expected:** the coach sees and resolves the lineup warning, enters attendance and score offline, reconnects, and verifies both accepted changes synchronize (with a separate conflict assertion if needed).
- **Request:** extend or add the required browser flow with lineup warning and successful offline score synchronization, with axe checks.
- **Status:** open coverage gap; no product defect established.

### QA-ACC-018 — Double-elimination external-team journey is missing

- **Owner:** Track G
- **Phase:** 9, required journey 18
- **Evidence:** `e2e/schedule-tournament.spec.ts` now creates and publicly renders a 13-team double-elimination bracket from internal team-season entries, checking the initial winners round and bye propagation. It does not enter external teams, record match outcomes, or follow advancement through the final.
- **Reproduce:** run `e2e/schedule-tournament.spec.ts`; it stops after verifying the generated bracket and public opening round.
- **Expected:** a desktop browser flow enters external teams, runs the double-elimination bracket through the final, and verifies the winner, with axe checks.
- **Request:** extend the desktop Playwright acceptance journey to register external teams, enter results across winners and losers brackets, and verify the champion after the final; retain axe checks.
- **Status:** partial browser coverage added on the latest trunk; external-team progression through the final remains open. Browser execution is pending the isolated QA stack.

### QA-ACC-019 — Swim-meet results and team scoring browser journey

- **Owner:** Track G
- **Phase:** 9, required journey 19
- **Evidence:** Current trunk includes `e2e/schedule-meet.spec.ts`: the browser creates six contests for 40 swimmers, saves heat/lane/seed assignments, submits final timed entries, verifies tie places, and asserts the configured home/away team points.
- **Reproduce:** run `e2e/schedule-meet.spec.ts` on the Chromium desktop and WebKit mobile projects.
- **Expected:** a desktop browser flow enters timed results and verifies team scoring with axe checks.
- **Request:** none; G reports this journey passed both browser projects with axe. QA's exact integrated-head CI remains pending.
- **Status:** journey coverage delivered on trunk; no product defect established. Awaiting exact-head CI confirmation.

### QA-ACC-020 — Officials assignment and pay-batch browser journey

- **Owner:** Track G
- **Phase:** 9, required journey 20
- **Evidence:** Current trunk includes `e2e/schedule-officials.spec.ts`: staff offers crews for ten games, officials accept/decline, staff reassigns the declined slot, and the browser verifies the 30-line pay batch and total.
- **Reproduce:** run `e2e/schedule-officials.spec.ts` on the Chromium desktop and WebKit mobile projects.
- **Expected:** staff assigns officials, an official declines, staff reassigns, and a pay batch is created and verified in the browser with axe checks.
- **Request:** none; G reports this journey passed both browser projects with axe. QA's exact integrated-head CI remains pending.
- **Status:** journey coverage delivered on trunk; no product defect established. Awaiting exact-head CI confirmation.

### QA-ACC-021 — Communications journey omits quiet-hour deferral and unsubscribe

- **Owner:** Track H
- **Phase:** 10, required journey 21
- **Evidence:** `e2e/communications.spec.ts` covers bilingual composition, test-send and schedule cancellation. It does not assert quiet-hour delivery deferral or complete tokenized unsubscribe in a browser. H reports service-level integration coverage for quiet hours and unsubscribe.
- **Reproduce:** run the campaign journey and inspect its flow; it cancels the schedule without sending a campaign to a recipient during quiet hours or following the unsubscribe link.
- **Expected:** a campaign to a opted-in recipient is deferred until quiet hours end; the recipient follows the signed unsubscribe link, sees the confirmation page, and the category preference becomes disabled.
- **Request:** extend/add the Phase 10 browser journey for both quiet-hour deferral and tokenized unsubscribe using preview/Mailpit adapters.
- **Status:** open coverage gap; no service defect is established by the current tests.


### QA-ACC-024 — Academy browser journey omits tuition proration and level promotion

- **Owner:** Track I
- **Phase:** 12, required journey 24
- **Evidence:** `e2e/classes.spec.ts` covers absence, make-up credit issuance, family booking, and staff attendance; it does not exercise monthly tuition/proration or a level promotion.
- **Reproduce:** run the classes journey and inspect its steps; it finishes after attendance is saved for the make-up session.
- **Expected:** the browser flow exercises monthly tuition with proration, make-up booking, and a level promotion, then verifies the resulting enrollment/tuition state and axe checks.
- **Request:** extend or add the academy Playwright journey to cover the missing billing and promotion acceptance paths.
- **Status:** open coverage gap; no product defect established.

### QA-PERF-001 — App bundle exceeds the enforced gzip budget

- **Owner:** Track C
- **Phase:** 16 §2.5
- **Evidence:** `npm run build` succeeds, but the configured `package.json` size limit is 200 KB gzipped and the current `npm run size` measurement is 404.93 KB gzipped.
- **Reproduce:** run `npm run build && npm run size`; size-limit exits 1 with “Package size limit has exceeded by 204.93 kB”.
- **Expected:** the production entry bundle meets the configured 200 KB gzip budget through appropriate code splitting and deferred feature imports.
- **Request:** reduce the entry bundle to the enforced budget and add `npm run size` to the final launch gate.
- **Status:** open; `npm run build` itself is green, but the separate bundle-budget check fails.

### QA-QUAL-001 — Knip launch gate fails on unused files and exports

- **Owner:** Tracks A, C, G, I, and J; Track C owns the launch gate. The federation demo helper is pending integration by Track K.
- **Phase:** 16 §1.3
- **Evidence:** the post-Phase 13 `npm run knip` exits 1 with 8 unused files, 44 unused exports, 28 unused exported types, and 1 duplicate export. New federation findings include unused `server/src/modules/federation/demo.ts`, `federationConsoleNav`, `expandAvailabilityWindows`, and `withFederationAccess`; the duplicate is `eventSeriesCreateSchema|eventSeriesSchema`.
- **Reproduce:** run `npm run knip`; the output names the unused files, exports, and duplicate.
- **Expected:** `npm run knip` exits 0 after owners remove dead exports/files or wire intended public contracts into their generated registries.
- **Request:** have C coordinate the current findings across A/C/G/I/J and the federation demo contract with K; wire intended APIs or remove genuinely dead files/exports, then make the required Knip gate green. QA removed its own unused `OrganizationRole` crawler type; no other QA-owned Knip finding remains.
- **Status:** open cross-track quality gate.

### QA-ACC-030 — Manual keyboard-only acceptance script is missing

- **Owner:** Track D
- **Phase:** 16 §3.1
- **Evidence:** `docs/qa/ACCESSIBILITY.md` now documents all 27 journeys in `30 §3`, including dialogs, menus, calendar/board alternatives, and focus behavior. No completed human keyboard-pass record has been added yet.
- **Reproduce:** review the keyboard-only instructions and journey checklist in `docs/qa/ACCESSIBILITY.md`; the checklist is present, but its record section has not been completed by a human reviewer.
- **Expected:** `docs/qa/ACCESSIBILITY.md` documents keyboard-only checks across all 27 journeys in `30 §3`, including dialogs, menus, calendar/drag alternatives, and focus behavior; the human reviewer records the completed pass.
- **Request:** perform the documented keyboard-only review on desktop and iPhone 13 viewports, then add its acceptance record and blocking controls.
- **Status:** script criterion met on `fix/d`; human keyboard execution and the acceptance record remain open.

### QA-ACC-031 — CI has no English-to-Spanish completeness check

- **Owner:** Track D
- **Phase:** 16 §3.3
- **Evidence:** `web/src/lib/i18n-completeness.test.ts` checks every English UI catalog (`auth`, `console`, `platform`, `portal`, `public`, `shell`, and `site`) for non-empty Spanish values, and `server/src/integrations/email/templates/auth.test.ts` checks matching, non-empty English/Spanish email subjects and bodies. Vitest runs these checks in the CI `test` job. The web regression also verifies that absent and blank nested translations are detected.
- **Reproduce:** run `npx vitest run web/src/lib/i18n-completeness.test.ts`; the CI `test` job also runs the server email catalog test.
- **Expected:** CI fails when any English key in the portal, site, auth, or email namespaces has no Spanish value.
- **Request:** keep the completeness regressions in the hosted Vitest `test` job and confirm them on the exact integration head.
- **Status:** implementation present on `fix/d`; the focused web test passes 2/2. Hosted exact-head CI confirmation is pending.

### QA-ACC-032 — Accessibility statements are absent from public site surfaces

- **Owner:** Track D
- **Phase:** 16 §3.4
- **Evidence:** the statement page is present at `/legal/accessibility` and linked from the marketing site and organization-site footer; the public legal-route browser journey includes axe checks.
- **Reproduce:** inspect `web/src/marketing/LegalPage.tsx`, the marketing footer, and `web/src/site/SitePage.tsx`; run the hosted `e2e/design/legal-drafts.spec.ts` journey.
- **Expected:** a public accessibility statement is linked from the marketing site and each organization-site footer when those surfaces land.
- **Request:** retain the public statement links and legal-route browser coverage as site routes evolve.
- **Status:** implemented on `fix/d`: the accessibility statement is linked from the marketing site and organization-site footer; public legal routes have browser coverage. Latest integration CI has no D-owned accessibility-page failure.

### QA-ACC-047 — Family registration journey does not cover sibling discount, ACH or bilingual confirmation

- **Owner:** Track E
- **Phase:** 5, required journey 8
- **Evidence:** `e2e/registration.spec.ts` registers two children, signs waivers and selects uniform sizes, but the fixture uses a free offering and does not configure a sibling rule, submit an ACH payment, or inspect confirmation email delivery in English and Spanish.
- **Reproduce:** run the family registration journey and inspect its fixture and assertions; no positive price, sibling discount, ACH method, settlement, or Mailpit locale assertion is present.
- **Expected:** the browser flow registers two children with the household sibling discount, submits ACH through the fake/test payment boundary, proves confirmation only after the expected settlement state, and asserts English and Spanish confirmation messages without sending real email or moving live money.
- **Request:** extend the E-owned acceptance journey with a positive-priced household discount fixture, test-mode/fake ACH settlement, and preview/Mailpit assertions for both locales; assert the recorded discount and payment totals.
- **Status:** open required journey coverage gap; the current flow exercises only free registration.

### QA-ACC-048 — Waitlist browser journey bypasses the staff UI and offer notice

- **Owner:** Track E
- **Phase:** 5, required journey 10
- **Evidence:** `e2e/registration.spec.ts` now joins three waitlisted participants, triggers offers by posting the staff cancellation API directly, accepts the first offer through the family UI, completes free checkout, and asserts confirmed registration plus the accepted waitlist link. It expires the second offer and checks the third is offered. It does not use the staff cancellation screen or assert delivery of the offer notice.
- **Reproduce:** run the waitlist journey and inspect `cancelAsStaff`; it uses `page.context().request.post()` rather than the staff UI, and there is no preview/Mailpit assertion for the offer notice.
- **Expected:** staff releases a place through the normal staff workflow; the family receives the preview notice, accepts the offer and completes checkout; waitlist, registration, and capacity remain consistent. Axe covers both staff and family screens.
- **Request:** extend the journey to create the offer through the staff UI and assert the synthetic preview notification, while retaining the current browser acceptance, expiry, and database assertions.
- **Status:** partial required journey is covered on trunk; the staff-UI and notification acceptance steps remain open.

### QA-ACC-049 — External captain team-entry acceptance lacks a browser journey

- **Owner:** Track E
- **Phase:** 5, required journey 11
- **Evidence:** Track E's service acceptance tests cover external team entry, verified player invites, household checkout and staff decisions, but no Playwright spec in `e2e/` exercises those UI steps.
- **Reproduce:** search `e2e/` for a captain/team-entry browser flow; no match is present.
- **Expected:** an external adult captain verifies their identity, creates a team entry, invites players through one-use links, each invited household completes its own registration and waiver requirements, and scoped staff approval moves capacity holds exactly once.
- **Request:** add the missing desktop and iPhone 13 browser journey using synthetic accounts, test-mode/fake checkout and axe checks; assert invite replay and final approval state.
- **Status:** open required journey coverage gap; the existing service-level tests do not establish browser acceptance.

### QA-ACC-050 — Launch-gate snapshot does not match the current trunk head

- **Owner:** Track C
- **Phase:** 16 final gate
- **Evidence:** current `rebuild/trunk` is `5cdee29e`. The committed `docs/codex/LAUNCH-GATE.md` records a local candidate based on `6dbb0e2a` and an earlier D candidate, not this committed trunk head or QA's crawler/journey branch. Its item 10 still says that no route crawler exists, although QA has `e2e/crawler/routes.spec.ts` and Phase 8–15 journeys.
- **Reproduce:** compare `git rev-parse rebuild/trunk` with the gate's recorded candidate and CI/test evidence; trunk is `5cdee29e` while the gate documents a candidate based on `6dbb0e2a`.
- **Expected:** the gate records the current committed trunk hash, exact-head CI/test evidence and phase integration state before final promotion decisions.
- **Request:** refresh the launch-gate snapshot from current committed trunk and exact-head CI; include the QA crawler/journeys only after integration and report all-role results. Keep item 10 failed until route, 404/500, error-state and role coverage are verified. Do not promote `main` unless all criteria pass.
- **Status:** open gate-evidence freshness gap. QA crawler and journeys are not yet integrated; the committed gate also predates current trunk `5cdee29e`.

### QA-ACC-051 — Valid team-entry invite UUID digest bytes can abort invite checkout

- **Owner:** Track E
- **Phase:** 5 team-entry invite checkout
- **Evidence:** `server/src/modules/registration/team-entries.ts:156` hashes a namespace with SHA-256, takes the first 16 bytes, then treats a zero byte at position 6 or 8 as an incomplete UUID. A complete 16-byte SHA-256 digest is allowed to contain zero bytes; those positions are subsequently masked to set UUID version and variant bits.
- **Reproduce:** call `stableUuid()` with any deterministic namespace whose digest has byte 6 or 8 equal to zero. The guard throws before producing the UUID. `createTeamEntryInvite()` uses this helper to derive checkout and invoice-line IDs from valid invite IDs.
- **Expected:** every complete 16-byte digest yields a deterministic UUID; only a missing/short digest should be rejected.
- **Request:** replace the truthiness guard with a digest-length check and add deterministic fixtures for zero bytes at digest positions 6 and 8, including the invite checkout-key derivation path.
- **Status:** high-confidence static runtime defect; invite creation may fail for valid inputs based on digest contents.

### QA-ACC-052 — Evaluation offer journey stops before deposit checkout is exercised

- **Owner:** Track E (checkout; coordinate Track C wiring and Track F acceptance)
- **Phase:** 6, required journey 12
- **Evidence:** `e2e/evaluations.spec.ts` mocks the offer acceptance response, then asserts only that the browser navigates to `/register/checkouts/:checkoutId/requirements`. It does not load checkout requirements, pay the advertised deposit, verify any remainder/autopay plan, or verify registration/team-roster persistence. Track F reports the production `OfferCheckoutAdapter` is still unwired and its acceptance operation remains an open E/C dependency.
- **Reproduce:** inspect the family offer test at `e2e/evaluations.spec.ts`; after `Accept and continue to deposit checkout`, the test only asserts the requirements URL and one mocked request.
- **Expected:** a real seeded offer acceptance creates an offer-bound registration and checkout; the family completes the test-mode deposit flow, any agreed remainder plan is recorded, and the resulting roster/registration state is persisted exactly once.
- **Request:** implement and wire the offer checkout path across E/C, then extend the desktop and iPhone 13 journey through deposit settlement and persisted registration/roster assertions, with axe checks and idempotent replay coverage.
- **Status:** open Phase 6 acceptance and integration gap; current browser assertion proves only the mocked navigation contract.

### QA-SEC-015 — Class booking accepts a household unrelated to the linked person

- **Owner:** Track I
- **Phase:** 12 class bookings and household privacy
- **Evidence:** `server/src/modules/classes/routes.ts` verifies the caller's active link to the requested `personId`, but `personHousehold()` returns any supplied `householdId` without checking the person/household membership. The portal drop-in and punch-card booking services then persist or invoice that supplied household without validating the pair; the schema only checks that both IDs belong to the organization.
- **Reproduce:** as a guardian with a valid link to child A, POST `/api/v1/classes/orgs/:orgId/me/drop-in` with child A's `personId` and a valid same-org household ID containing child B. The route currently accepts the drop-in and stores it under child B's household.
- **Expected:** reject a supplied household unless an active `household_members` row links that household and person in the same organization; return 404 without creating a booking or invoice.
- **Request:** validate the active household/person pair in the shared route helper and in the service transaction paths for drop-ins and punch-card purchases, then keep the active regression in `e2e/security/class-booking-guardian-idor.spec.ts` green.
- **Status:** runtime-confirmed in the isolated QA Chromium run at trunk snapshot `d52e4c83`: the forged-household drop-in returned 201 and persisted under the unrelated household.

### QA-SEC-016 — Tenancy fuzz accepts vacuous 404s for random resource IDs

- **Owner:** Track C
- **Phase:** 16 §1.2
- **Evidence:** the current C branch metadata and matrix are present in its local branch reference, but its `tenancy-fuzz.spec.ts` still replaces resource IDs with random UUIDs, omits same-tenant controls, and enumerates only GET/PATCH/DELETE. Current trunk has no metadata, so this coverage cannot yet execute meaningfully against the integrated route inventory.
- **Reproduce:** on a metadata-backed route such as `/api/v1/orgs/{orgId}/people/{personId}`, observe that the generated `personId` is not a fixture row. A route returning 404 for every missing person passes the foreign assertion without exercising isolation. Compare the method allow-list with ID-bearing OpenAPI operations.
- **Expected:** every ID-bearing tenant route has fixture metadata or a deterministic seeding helper for its referenced resource IDs and valid mutation payloads. The same-tenant control must reach the expected authorized outcome before the test changes only the tenant path ID and requires 404. Cover tenant-scoped create/update methods as well as reads and deletes.
- **Request:** supply real synthetic path resource IDs and run a same-tenant control for each descriptor, then issue the foreign-tenant request with the identical resource ID/body and assert 404. Extend enumeration to every applicable ID-bearing HTTP operation; do not count a missing-resource 404 as isolation evidence.
- **Status:** open test-quality gap; keep active until valid resource IDs, same-tenant controls, and applicable mutation methods are covered and run on an integrated trunk head.

### QA-ACC-053 — Route crawler omits registered detail routes outside navigation

- **Owner:** Track C (generated route inventory; coordinate QA crawler fixtures)
- **Phase:** 16 §3, launch-gate item 10
- **Evidence:** `e2e/crawler/routes.spec.ts` follows rendered nav links, visible same-origin content links, and navigation buttons; it also checks same-origin HTTP/API failures, rendered error states, page/console errors and axe. It still does not enumerate `webFeatures` / `webNestedRoutes`, so registered detail routes without a visible link and seeded resource (person, household, message, event, invoice) remain outside the route queue. Its actor fixtures cover 11 org roles, guardian/self and three platform roles, but not the documented record-derived `head_coach`, `assistant_coach`, `team_manager`, `treasurer`, official or volunteer contexts; no `team_staff`, `official_assignments` or volunteer signup records are seeded.
- **Reproduce:** compare route patterns in `web/src/generated/nested-routes.ts` and derived-role access in `docs/codex/04-PERMISSIONS-AND-PRIVACY.md` with `crawlNavigation()` and the actors created in `e2e/crawler/catalog.ts` / `routes.spec.ts`; dynamic detail routes without linked fixtures and the derived role contexts are absent from the crawl inputs.
- **Expected:** launch-gate item 10 coverage includes registered routes with valid synthetic resource IDs and authorized role contexts, including documented team-staff, official and volunteer identities; rendered navigation/content traversal remains part of the crawl.
- **Request:** expose a lightweight route inventory with role/fixture expectations for unreachable dynamic routes, and seed crawler actors with valid record-derived coach/team-staff, assigned-official and volunteer relationships. QA already traverses reachable page-content links and nav buttons.
- **Status:** open route-crawler completeness and role-context gap; runtime verification remains blocked by the occupied QA database/browser ports.

### QA-ACC-054 — Phase 6 integration test does not verify age at program start

- **Owner:** Track F
- **Phase:** 6 Rec team balancing
- **Evidence:** `server/src/modules/evaluations/service.ts` calculates age from `target.starts_on`, but `phase6.integration.test.ts` only asserts each generated `meanAge` is a positive number. It would not catch using the current date or an off-by-one birthday calculation instead of the program start date.
- **Reproduce:** review the new age assertion around `phase6.integration.test.ts:1511`; the people fixtures do not assert their expected whole-year age or resulting exact team mean.
- **Expected:** the database path supplies each player's whole-year age on the target program start date, including a birth date whose birthday falls just after that date; team metrics reflect those exact values.
- **Request:** use deterministic DOB/program-start fixtures that distinguish target-date age from wall-clock age and assert expected ages or team means at the service boundary.
- **Status:** test-quality gap; static SQL review confirms the current implementation uses `target.starts_on`, and QA's real-Postgres stack remains unavailable for runtime verification.

### QA-ACC-055 — Credential compliance chart counts stale verified credentials

- **Owner:** Track D
- **Phase:** 14 reports and Phase 16 acceptance evidence
- **Branch evidence:** current integrated `rebuild/trunk` snapshot `5cdee29e`.
- **Evidence:** `ReportsDashboard.tsx` builds the credential compliance percentage from counts grouped only by `status`, and treats every `status === 'verified'` row as compliant. The credentials report definition excludes revoked rows but does not include `expires_on` in the chart input or constrain the verified count by expiry. The shared compliance policy considers a verified credential invalid when `expiresOn < onDate`; expiry status is updated asynchronously by the credentials-expiry job, so a stale row can remain `verified` after its expiry date.
- **Reproduce:** seed a non-revoked credential with `status = 'verified'` and `expires_on` before the report's as-of date, then render the credential compliance chart before the expiry job changes its status. The chart includes it in the “Verified” numerator, while the compliance policy rejects it.
- **Expected:** the compliance percentage counts only credentials valid on the report's as-of date as compliant, using the policy's inclusive `expires_on` boundary; expired verified rows remain in the denominator as needing attention. Add a deterministic report/query or dashboard regression covering an overdue-but-not-yet-swept verified credential and a still-valid credential.
- **Request:** include expiry validity in the compliance aggregation (with a documented as-of date and `expires_on` null/valid handling) or derive a policy-backed compliant value, and assert the percentage before the expiry sweep runs. Keep the existing revoked exclusion and role access rules.
- **Status:** fixed on `fix/d`; expired verified credentials are excluded from the compliant numerator while remaining in the denominator. The deterministic dashboard regression passed in the hosted `test` job for run `36662938527`.

### QA-ACC-056 — Expired organization export archives remain in storage

- **Owner:** Track D
- **Phase:** 14 organization data export and retention
- **Branch evidence:** current integrated `rebuild/trunk` snapshot `5cdee29e`.
- **Evidence:** `buildOrganizationExport()` stores the ZIP in `Storage` and sets the `files.expires_at` and `org_data_exports.expires_at` fields to seven days after creation. `downloadOrganizationExport()` denies a download after that timestamp, but the `retention.sweep` job never selects expired exports or deletes their storage objects. The only `storage.delete()` in the export service is in the build-failure cleanup path; no general file-expiry janitor exists in the D branch.
- **Reproduce:** create a completed export, advance the clock beyond its `expires_at`, and run the registered `retention.sweep`; verify the link is denied but the ZIP remains in storage and the file record remains active.
- **Expected:** the seven-day export expiry ends both link access and retention of the sensitive archive bytes. The sweep removes the expired object and safely retires its file/export metadata while preserving required audit evidence.
- **Request:** add storage-aware expiry cleanup for export ZIPs, make deletion and metadata updates safe across partial failures, and add a fake-storage regression proving an expired archive is deleted while a live one and its link remain usable.
- **Status:** fixed on `fix/d`; expired export objects and metadata are retired through the retention sweep with retryable storage cleanup. The database-backed regression passed in the hosted `test` job for run `36662938527`.

### QA-ACC-057 — Person photo bytes persist after deletion anonymization

- **Owner:** Track D
- **Phase:** 14 privacy-request deletion/anonymization
- **Branch evidence:** current integrated `rebuild/trunk` snapshot `5cdee29e`.
- **Evidence:** the approved-person deletion path collects the person's photo and credential file IDs, clears the references, and sets `files.deleted_at`, but it does not receive or call a `Storage` implementation. The photo bytes therefore remain in local or object storage after anonymization. Credential attachments may have a separate compliance-record retention obligation and should follow that documented schedule.
- **Reproduce:** create a person photo in fake storage, complete an approved deletion/anonymization request, and inspect the storage object; the database row is tombstoned but the photo bytes remain.
- **Expected:** approved anonymization erases or cryptographically destroys the person's photo bytes while retaining the required file/audit tombstones. Credential evidence follows its explicit legal/compliance retention rule rather than being blindly deleted or retained forever.
- **Request:** make the privacy deletion path storage-aware for photos, with retryable cleanup for database/storage partial failure, and add fake-storage coverage proving the photo is removed and unrelated files remain. Explicitly define the credential-attachment retention treatment.
- **Status:** fixed on `fix/d`; approved anonymization removes photo bytes after commit with a retry marker and retains credential evidence through its defined retention period. The database-backed regression passed in the hosted `test` job for run `36662938527`.

### QA-SEC-017 — Public website SSR lacks a stored-XSS regression

- **Owner:** Track D
- **Phase:** 14 website SSR and Phase 16 §1 stored-XSS acceptance
- **Branch evidence:** current integrated `rebuild/trunk` snapshot `5cdee29e`.
- **Evidence:** organization names, news titles, and news body text reach `server/src/modules/website/public.ts`; the renderer currently uses React text nodes and `safeJsonLd()` escapes `<`, `>`, and `&`, which appear safe by static inspection. Existing `server/test/security/stored-xss.test.ts` covers campaign HTML only, and D's website SSR integration tests do not persist script/event-handler payloads or assert they remain inert in the served document.
- **Reproduce:** persist a synthetic payload such as `</script><script>window.__xss=1</script><img src=x onerror=...>` in a published news title/body and an organization name, request the SSR document, and inspect parsed DOM/execution. Current positive fixtures cover ordinary text but not hostile stored values.
- **Expected:** no attacker-controlled script, event handler, or executable URL is created; text remains escaped and JSON-LD remains a single inert script node.
- **Request:** add a deterministic stored-XSS SSR regression for organization identity and published news/page content, asserting parsed DOM has no injected active elements or handler attributes. The current implementation appears defensive; this is a test-quality gap, not a confirmed exploit.
- **Status:** fixed on `fix/d`; hostile organization identity, news, and page content are exercised through actual SSR responses, and the database-backed regression passed in the hosted `test` job for run `36662938527`. No exploit was confirmed.

### QA-SEC-018 — Key rotation omits three encrypted data fields

- **Owner:** Track SEC
- **Phase:** 16 §1 key management
- **Branch evidence:** current integrated `rebuild/trunk` snapshot `5cdee29e`.
- **Evidence:** `rotateEncryptedData()` enumerates encrypted columns in `server/src/lib/security/encryption-rotation.ts`, but omits `athlete_cards.qr_secret_enc` and `checkouts.requirements_enc`, both written with `encryptRestricted()`. It also omits `fundraising_settings.ein_ciphertext`, which is produced by `encryptRestricted()` but stores ciphertext, nonce, and key ID separately in `ein_ciphertext`, `ein_nonce`, and `ein_key_version`. Rotation therefore leaves all three values on the old key while reporting its scan complete.
- **Reproduce:** insert all three values encrypted under `previous`, run `scripts/rotate-encryption-key.ts --apply` with `next` active and both keys configured, then decrypt using a keyring containing only `next`; card and checkout values still carry the old embedded key ID, and the fundraiser EIN still records `previous` in `ein_key_version`.
- **Expected:** every `encryptRestricted()` data field is included in rotation, including split-envelope formats, and the integration test proves old-key ciphertext in each field is re-encrypted, remains readable under the new key, and is counted in dry-run/apply summaries.
- **Request:** add the card and checkout columns to the bounded tenant-scoped rotation list; add a dedicated split-envelope handler for `fundraising_settings.ein_ciphertext` that updates its stored key ID and ciphertext. Exercise all three through the operator CLI and add a schema/list completeness guard so new encrypted fields cannot silently be omitted.
- **Status:** high-confidence key-rotation defect on current trunk; the CLI test covers only medical-profile and MFA ciphertext, leaving the omitted fields untested. QA has not run the database-backed regression against its exact integrated head.

### QA-SEC-019 — Permission matrix completeness test does not exercise route authorization

- **Owner:** Track C
- **Phase:** 16 §1.2; `04-PERMISSIONS-AND-PRIVACY.md` §1
- **Branch evidence:** current trunk and latest Track C head `29f025c3`.
- **Evidence:** `e2e/security/permission-matrix.spec.ts` verifies that every OpenAPI operation has a matrix row whose allow/deny arrays partition the known roles, and that row permission/scope strings match metadata. It sends no requests and does not compare any allow/deny expectation with runtime route behavior. `route-authorization.spec.ts` likewise verifies metadata presence only.
- **Reproduce:** change one operation's matrix row to allow a role the route rejects, or deny a role the route accepts; the current matrix and route-authorization checks still pass because they never invoke the endpoint as that role.
- **Expected:** an executable route-authorization matrix exercises declared allow/deny outcomes against each route using valid synthetic fixtures, with scoped-role cases proving access boundaries. If a method cannot be safely invoked in both modes, its descriptor should provide a safe request fixture or an explicit documented policy test.
- **Request:** extend the generated test contract so the matrix is checked against actual authorization decisions, not just metadata shape. Use isolated synthetic data and safe GET/denial requests or a route-level authorization harness; never send real messages or move real money.
- **Status:** high-confidence test-coverage gap; C's 702-row matrix is structurally complete, but runtime allow/deny semantics remain unverified across the route set. Database-backed execution is blocked by the occupied QA offset.

### QA-ACC-058 — Organization exports bypass shared object storage

- **Owner:** Track D (export module), coordinate Track C (app/worker storage wiring)
- **Phase:** 14 organization data export; Phase 16 production acceptance
- **Branch evidence:** current integrated `rebuild/trunk` snapshot `5cdee29e`.
- **Evidence:** `createExportsRouter()` constructs `LocalDiskStorage('data/uploads')`; `buildOrganizationExport()` and `downloadOrganizationExport()` also default to that local adapter, and `runOrganizationExportJob()` does not receive a configured storage dependency. The production architecture requires a private S3-compatible bucket and the production plan runs two web instances plus a separate worker.
- **Reproduce:** run the export job on the worker's local filesystem, then issue its signed download URL through a web instance with a different filesystem; the export row and token exist, but that instance cannot read the ZIP object.
- **Expected:** export creation and download use the same configured durable, private `Storage` adapter across worker and web processes; tests prove a ZIP written by the job can be downloaded through the shared adapter.
- **Request:** inject configured storage through the generated module/app and worker dependencies instead of constructing `LocalDiskStorage` in the export module, and add a fake/shared-storage integration test covering build-to-download across separate service instances.
- **Status:** D's export router and build/retention handlers accept an injected `Storage`, and the build/download/cleanup regression uses a shared fake adapter. Production wiring is still open: Track C must pass the configured adapter to the router and worker handlers before this can close.

### QA-QUAL-002 — Program status mutation silently strips unknown request fields

- **Owner:** Track B
- **Phase:** 3 API contract and request validation
- **Branch evidence:** newly merged Track B slice `bc9b22b3` centralizes the program status schema and regenerates OpenAPI.
- **Evidence:** `POST /api/v1/programs/orgs/:orgId/:programId/status` parses the body with `z.object({ status, expectedVersion })`, and the corresponding `moduleDefinition.openapiRoutes` body also uses `z.object`. Zod strips unknown properties by default, while the repository request-schema rule requires strict objects and OpenAPI describes this body with `additionalProperties: false`.
- **Reproduce:** submit a valid status and `expectedVersion` plus an extra property (for example `unexpected: true`) to the status route. The current parser ignores the extra key and proceeds with the transition instead of returning 400.
- **Expected:** reject unknown request fields with 400 before changing the program state; runtime validation and the generated OpenAPI contract must agree.
- **Request:** use `z.strictObject` for the status request body in both the route parser and module descriptor, and add a regression asserting that an unknown field returns 400 and leaves the status/version unchanged.
- **Status:** static contract defect on trunk `bc9b22b3`; a database-backed mutation regression has not run on the isolated QA stack.


### QA-ACC-059 — Team-finance journey mutates append-only allocations

- **Owner:** Track H
- **Phase:** 11 team finance / Phase 16 acceptance
- **Evidence:** Track B's Chromium run on trunk `5651da37` failed in `e2e/phase11.spec.ts:437–441` when the test updated `payment_allocations.installment_id` through the app role. Migration `0103_spine_finance_core.sql` configures `payment_allocations` as append-only and grants the application role SELECT/INSERT, not UPDATE; the database correctly returned `permission denied for table payment_allocations`. This was observed in B's run; QA's own browser suite has not run on its isolated stack.
- **Reproduce:** execute the “team finances issue three installments” Playwright scenario. Its fixture directly updates an existing allocation row under `withOrg`.
- **Expected:** the journey sets up installment allocations through the supported service/repository or inserts the final fixture state, without adding UPDATE permission to an append-only finance table.
- **Request:** replace the direct UPDATE fixture with a supported setup path or seed the installment allocation on insert, and keep the regression proving the team-finance flow creates the intended installments. Do not loosen the table's append-only policy.
- **Status:** H's latest track note reports a passing post-repair run, but the current trunk journey still contains the direct allocation update. Reconcile the mismatch with the exact-head CI result before closing; preserve the append-only policy.

### QA-ACC-060 — Valid sibling registration quote returns 500

- **Owner:** Track E
- **Phase:** 5 registration / required journey 8
- **Evidence:** Track B's Chromium run on trunk `5651da37` failed the existing free two-sibling registration journey. The quote request `POST /api/v1/registration/orgs/:orgId/checkouts/:checkoutId/quote` returned HTTP 500 with the generic `INTERNAL_ERROR`; the browser stayed on “Review your registration” and never reached “Registration confirmed.” QA's own browser suite has not run on its isolated stack.
- **Reproduce:** run `e2e/registration.spec.ts` for the valid free two-sibling checkout and inspect the quote response in the trace.
- **Expected:** a valid quote completes and the family reaches a confirmed registration state.
- **Request:** diagnose and fix the quote-generation error; retain a positive browser or integration regression asserting a valid quote and completed registration. Keep the separate sibling-discount/ACH/localization coverage request in QA-ACC-047.
- **Status:** acceptance failure reported from B's Chromium run on trunk `5651da37`; QA has not independently reproduced it.

### QA-ACC-061 — Valid finalized contest result returns 500

- **Owner:** Track G
- **Phase:** 8–9 schedule and result reporting
- **Evidence:** Track B's Chromium run on trunk `5651da37` failed `e2e/schedule-stats.spec.ts:241`. A valid `head_to_head_score` submission with result stats sent to `POST /api/v1/contests/orgs/:orgId/contests/:contestId/results` returned HTTP 500 with `INTERNAL_ERROR`; the UI never showed “Result submitted.” QA's own browser suite has not run on its isolated stack.
- **Reproduce:** run the schedule-stats journey and submit the finalized head-to-head score plus its result stats.
- **Expected:** the valid finalized result is accepted, its result and stat lines persist, and the UI reports success.
- **Request:** inspect the server error path and add a regression proving valid finalized score and stat-line persistence end to end.
- **Status:** acceptance failure reported from B's Chromium run on trunk `5651da37`; QA has not independently reproduced it.

### QA-ACC-062 — Opening a team chat returns 400 after persisting the conversation

- **Owner:** Track H
- **Phase:** 10 team chat / SafeSport guardian inclusion
- **Branch evidence:** QA Chromium run on trunk snapshot `d52e4c83`, before the subsequent Track E-only trunk update.
- **Evidence:** the owner-role team chat journey loads the active team and posts a valid request to `POST /api/v1/communications/orgs/:orgId/chat/conversations`. The service creates/synchronizes the team conversation, but `ensureTeamConversation()` omits `muted` from its returned object while the route parses the response with strict `conversationSchema`, which requires `muted: boolean`. The endpoint responds `400 VALIDATION_ERROR` with `path: ["muted"]`; the browser cannot select the newly created conversation, so the minor athlete's guardian inclusion/reply journey stops before messaging.
- **Reproduce:** run `e2e/journeys/chat-safesport.spec.ts` with the staff owner assigned an active team and completed MFA. The first team-chat click returns 400; retry also fails because the existing-conversation return omits `muted` too.
- **Expected:** both create and reopen return a schema-valid conversation including the persisted caller mute state, then the staff member can send and the linked guardian can read/reply.
- **Request:** include `muted` in both `ensureTeamConversation()` return paths (and check `ensureTeamStaffConversation()` for the same contract), then add route-level tests for first creation and idempotent reopen plus the browser guardian-reply assertion. Preserve strict response validation.
- **Status:** fixed in current trunk `5cdee29e`: both team-conversation return paths now include `muted: false`, satisfying the strict response schema. The QA branch's SafeSport journey retains the create/reopen and guardian-reply regression; its exact-head CI result is pending.

### QA-ACC-063 — Self-account medical view requests a guardian-only athlete link

- **Owner:** Track A
- **Phase:** 2 medical portal and self-account privacy
- **Branch evidence:** QA Chromium rerun against trunk snapshot `d52e4c83` with the isolated QA database and remapped API/web ports.
- **Evidence:** `FamilyMedical` renders `AthleteAccess` for every non-staff medical view, and `AthleteAccess` immediately queries `/api/v1/people/orgs/:orgId/:personId/athlete-link`. The self actor receives 404; the endpoint is intended for guardian access and guardian journeys remain supported.
- **Reproduce:** sign in as a self-linked athlete, open the family medical view in the role crawler, and observe the guardian-only athlete-link endpoint return 404.
- **Expected:** the self-account medical view issues no guardian-only request and renders no guardian-only controls; verified guardians retain access.
- **Request:** gate the athlete-link query and dependent controls on a verified guardian relationship; add self and guardian coverage so the self page has no 404/error state while guardian behavior remains functional.
- **Status:** runtime-confirmed by the QA role crawler; guardian journeys passed in the focused Chromium rerun.


### QA-ACC-064 — Configured Phase 15 AI provider does not enable the browser feature flag

- **Owner:** Track C (build-time flag), coordinate Track K (help/AI UI)
- **Phase:** 15 optional AI assistance
- **Branch evidence:** current integrated `rebuild/trunk` snapshot `5cdee29e`.
- **Evidence:** `web/src/console/help/ai-enabled.ts` renders AI only when `import.meta.env.VITE_AI_ENABLED === 'true'`. `vite.config.ts` does not derive or define that flag from the server's `AI_PROVIDER` and `ANTHROPIC_API_KEY` configuration. The server provider is configured independently in `server/src/modules/ai/provider.ts`; the Phase 15 browser journey asserts the disabled state but has no configured-provider positive assertion.
- **Reproduce:** build/run with `AI_PROVIDER=anthropic` and a synthetic test key while leaving `VITE_AI_ENABLED` unset. The server-side provider can be configured, but the console still hides the AI feature because the client flag is false.
- **Expected:** the non-secret client flag is true only when the supported provider and key are configured; the browser exposes the feature with a fake provider and makes no AI request when disabled. Never embed or log the provider key.
- **Request:** derive `VITE_AI_ENABLED` from server-side provider configuration at Vite startup/build without exposing the key, and add deterministic disabled/configured browser or config coverage using a fake adapter.
- **Status:** high-confidence static Phase 15 wiring gap on current trunk; the server can configure a provider, but the web feature flag is not derived. Runtime provider checks remain unverified on the QA integrated head.

### QA-ACC-065 — Public organization website SSR is not mounted in the shared application

- **Owner:** Tracks A and C (coordinate Track D)
- **Phase:** 14 public website, Phase 16 launch gate
- **Branch evidence:** current integrated `rebuild/trunk` snapshot `5cdee29e`.
- **Evidence:** this was a confirmed gap on the older `5cdee29e` trunk snapshot. D added `website.moduleDefinition.publicRouter`, mounted before the tenant API guards and SPA fallback; its shared-app regression now covers published pages, verified custom domains, host-root sitemap/robots aliases, and pending-domain rejection.
- **Reproduce:** request `/site/<published-org-slug>` and host-root SEO files against the shared app; compare the returned SSR document and aliases with the database fixtures in the website integration regression.
- **Expected:** published site pages, generated pages, and contact routes resolve through the shared app at the documented public path; sitemap/robots are available at each resolved site's host root, including an active verified custom domain, without tenant leakage. The role-aware crawler and public-site journey cover the mounted routes.
- **Request:** keep the public router registered before API guards and the SPA fallback, and retain the integrated-app smoke coverage for published pages and SEO routes.
- **Status:** fixed on `track/integration` at `4b7870fe`; the shared-app SSR regression passed in hosted run `36662938527`, including published sites, verified custom domains, host-root SEO aliases, and pending-domain rejection.

### QA-ACC-066 — Northstar demo seed uses an invalid IANA time zone

- **Owner:** Track K (demo seed)
- **Phase:** 15 demo profile; hosted acceptance CI
- **Branch evidence:** current integrated trunk snapshot `5cdee29e`; hosted QA CI run `36640228008` on branch head `910e0b0c`.
- **Evidence:** the hosted E2E summary reports `RangeError: Unrecognized time zone America/Minneapolis`. `db/seeds/demo.ts` assigns that value to the Northstar Gymnastics & Swim Academy profile at line 211; constructing an `Intl.DateTimeFormat` for the seeded organization fails because this is not a supported IANA zone identifier.
- **Reproduce:** seed the Northstar demo profile and format any organization-local date using its stored `timezone` value.
- **Expected:** every demo profile stores a valid IANA time zone matching its locale; Minneapolis uses `America/Chicago`. Add a seed validation regression so invalid zone identifiers fail clearly before they reach browser journeys.
- **Request:** replace the invalid Northstar zone and validate every demo-profile time zone in a focused seed test. Keep the seeded city and profile unchanged.
- **Status:** CI-reported failure with a direct source match; not yet verified after correction.

### QA-ACC-067 — Hosted Chromium public-site shell parity exceeds the existing threshold

- **Owner:** Track D (Linux parity baseline), coordinate Track A if the rendered shell itself changed
- **Phase:** 16 §3 design parity
- **Branch evidence:** hosted QA CI run `36640228008` on branch head `910e0b0c`.
- **Evidence:** the hosted E2E summary reports `390px public-site shell mismatch: 9.63% of pixels differ`. `e2e/design/parity.spec.ts` measures this public-shell comparison against `public-site-home-390.png` and requires the mismatch to remain below the existing 6.5% limit.
- **Reproduce:** run the `public site shell matches the legacy header and navigation at desktop and phone widths` journey in hosted Chromium and compare its 390px actual image with the committed reference.
- **Expected:** the public header/navigation matches the approved reference within the existing 6.5% limit on the hosted Linux runner, with no tolerance increase.
- **Request:** inspect the exact hosted actual/reference images, update only a proven stale Linux-specific reference or route a real shell regression to Track A, and rerun the same browser check. Preserve the 6.5% threshold and design tokens.
- **Status:** fixed on `track/integration`; the same-runner Linux shell references pass in hosted runs `36662938527` and `36663830530`, with no 390px shell mismatch, missing baseline, or component parity failure. The 6.5% threshold, macOS references, design tokens, and token-equality check are unchanged.
