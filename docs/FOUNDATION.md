# Fieldhouse foundation acceptance checklist

> Current status, September 12: core implementation is built; 184 tests and production build pass. See [FOUNDATION-REVIEW.md](FOUNDATION-REVIEW.md) for the current finite acceptance results and remaining user-assisted credential/waiver browser checks. No large backend handoff is indicated. The chronological evidence below includes older test counts and previously open checks; the current review supersedes them.

The current user objective is a functional, usable sports-management foundation for later development. LeagueApps is a reference, not a parity checklist. This document supersedes older replication requirements. No third-party partnership integrations are included.

## Completion gates

- [ ] Core workflows: program setup and configuration; adult/family account access and recovery; registration with eligibility, questions and waivers; roster/staff management; scheduling and results; invoice/payment records; cancellation, reenrollment and transfers; message preparation; public program discovery and commerce.
- [ ] Operational consistency: organization and family permissions; retained history; transaction-safe capacity, inventory and billing changes; explicit failed-action recovery; no misleading payment or delivery success states.
- [ ] Usable interface: every advertised navigation destination works; desktop/mobile core screens have readable layouts, accessible controls, loading/empty/error states, and no known overlap or inaccessible actions.
- [ ] Connected verification: browser journeys through enrollment, roster, billing, schedules, cancellation/transfer and commerce; focused regression tests for financial and access invariants; current build passes.
- [x] Handoff: accurate setup and service configuration documentation; backup/restore procedure tested; remaining deployment/provider requirements stated clearly.

## Current evidence and open work

- Cancellation: domain/HTTP tests, desktop/mobile review and fictional browser submission verified. Unpaid invoice voiding tested through HTTP; paid balances retained. Explicit regression tests now cover shared active-registration invoices and product-order invoices: cancellation cannot void either, and product stock reservations remain intact. Refund processing is not implemented.
- Reenrollment: migration preserves historical records and one-active-enrollment constraint; rollback test and backup migration passed. Browser reenrollment retained old answers/waivers and created fresh evidence.
- Transfer: transactional destination checks, price/status review and retries tested; fictional browser transfer verified. Confirmed-rejection recovery and review-data refresh are implemented. A read-only result lookup lets an uncertain submission recover its recorded result without resubmitting; tests verify request/source/organization scoping and completed versus missing results. Browser checks of these error states remain pending. Payments remain on the source invoice; destination invoicing is explicit, not a funds transfer.
- Last full suite: 158 passing tests including API failures, shared billing, recovery, organization-settings HTTP permissions and backup/restore.
- Member recovery backend and screens are implemented; domain/HTTP tests cover expiry, rotation, scope, session revocation, replacement login and rate limits. Desktop/mobile request screens inspected; unknown-account request returned the generic response through the browser. Recovery input height verified at 44px after correcting CSS specificity. Missing-token reset links were browser-verified to show a clear invalid-link message, navigate to a fresh request form, and return to sign-in with a visible recovery link. Full reset submission is covered by HTTP tests; browser reset completion remains unverified. Provider delivery, actual payment processing and production deployment are not operational; document these honestly and do not mark launch readiness.
- Organization settings now expose name and validated time-zone edits, restricted to owners/admins with audit history and stale-write protection. Domain and HTTP tests passed (unauthenticated rejection, manager/reporter write denial, owner save, stale-write rejection and isolation). Failed saves offer a reload-current-settings action. Settings rendered with current data in the browser at phone width; browser save of the existing name/time-zone returned success, and a full reload preserved both values. This created an audit entry but did not change configuration. Basic financial visibility exists in invoice filtering, balances, CSV export and payment-plan reporting; invoice CSV now explicitly identifies voided records. Advanced financial reporting remains deferred.

- Backup/restore: `npm run db:copy` creates validated SQLite snapshots without overwriting existing files. A real-file test passed for committed data, embedded assets, restore and file permissions. Procedure documented in `docs/BACKUP.md`; remote storage and production restore operations remain deployment responsibilities. README replaced with current foundation scope and provider limitations.

## Deferred extensions

Bookings, specialized tryouts/evaluation, advanced analytics/reporting workspace, alternate website editors/skins/widgets, public integration API management, copied partner integrations and gateway dashboard. Their unfinished navigation entries are removed, not counted as implemented. Existing partial tryout backend is retained for future development.

## Work discipline

Finish connected core workflows and meaningful checks in batches. Do not resume exhaustive source inspection or minor visual-parity refinements. Update this checklist with evidence; passing a unit test alone does not close an entire workflow gate.

## Browser usability evidence (2026-09-09)

Teams list inspected at desktop and 390px phone widths, including expanded details: text wraps and horizontal scrolling stays inside the data table. Invoice and program lists inspected at phone width: no visible overlap in sampled rows; small form controls prompted shared mobile touch sizing. This is sampled evidence, not an all-route or all-state certification. Backend restarted with current settings/recovery routes.

Initial navigation checks are recorded in `docs/NAVIGATION-VERIFICATION.md`: 28 administrative destinations plus seven member destinations loaded, supplementing earlier core-screen checks. One product-filter duplicate-key warning was corrected and browser-rechecked. This closes the initial-destination smoke check, not the full usable-interface gate.

Shared modal accessibility: dialogs now reference their visible title and restore focus to the connected opener on dismissal. Browser verification used keyboard Enter to open Add Team, confirmed the named dialog, then Escape to close; focus returned to Add a Team. No team was created.

Shared failure recovery: API errors now distinguish connection failure and unreadable responses from structured server errors, retaining transfer recovery flags. A regression test verifies no automatic write retry and preserves abort behavior. A root render-error boundary offers an explicit reload with unsaved-entry/result-review guidance instead of a blank screen. Build and focused API test passed. An isolated Vite transform deliberately threw during App rendering; browser verified the fallback heading, unsaved-entry guidance, dashboard link and reload button. Reloading with the deliberate fault still installed correctly showed the fallback again. The isolated preview was stopped; application source and active data were not modified by the fault injection.

## Workspace restore drill

The documented `db:copy` command backed up the running local workspace to `/tmp/fieldhouse-foundation-acceptance-backup.sqlite`, then restored it to `/tmp/fieldhouse-foundation-acceptance-restored.sqlite`. Read-only comparison of every application table found all 634 rows across 54 tables identical, including embedded file bytes. SQLite integrity returned `ok`; foreign-key violations: zero. The active workspace database was not replaced. This closes the local backup/restore handoff requirement; production backup storage/scheduling remain explicitly documented deployment work. Temporary files are verification artifacts, not a durable backup policy.

Transfer refresh review: initial source/program/team load failures now expose retry. Refresh and definite rejection reset the invoice choice to keep, discard the old quote and reload destination questions/waiver requirements before enabling another review. Program-list loading/errors also block submission. Build passed; browser changed-form scenario remains pending.

Restored workspace initialization also passed through `openDb` migrations and `makeApp` route setup: one organization, 38 registrations and 31 invoices; integrity remained `ok` with zero foreign-key errors. The automated restore test now opens the restored file with `openDb` as well. No listener, delivery worker or external messages were started during this check.

Session loading: administrator connection errors now offer retry rather than silently showing sign-in; post-login session loading is awaited. Member account session failures also expose retry. HTTP regression verifies anonymous admin session returns 401, anonymous member session returns 200/null, and authenticated admin session excludes password/token hashes. Full suite passed (158 tests). Browser connection-failure simulation remains pending.

Administrator/member sign-out actions now catch request failures, keep session state until server confirmation, prevent duplicate pending submissions, and show an actionable error. Build passed. Isolated preview middleware returned 503 for logout without forwarding it: browser verified both member and administrator alerts, retained signed-in identities and re-enabled Sign out controls. Preview stopped afterward; working sessions were unchanged.

Session failure browser check: an isolated Vite preview on port 5174 pointed to an unavailable API, showing the session-error screen and Retry. Retrying while unavailable remained actionable. Restarting the isolated preview with the working API triggered Vite's automatic page reload and restored Dashboard with the existing session. This verifies outage display and reload recovery, not a successful in-place Retry after reconnection. Both temporary preview processes were stopped; the primary app on 5173 remained running. No records were changed.

In-place session retry verified: isolated preview returned 503 for administrator and member session GETs. Both browser pages displayed their error/retry state. Clearing the middleware fault without restarting the preview and clicking each Retry restored Alex's administrator Dashboard and Casey's member Dashboard, with no page reload or credential entry. Temporary preview stopped; no data mutations.

Transfer required-form browser check: fictional Cancellation Verification's active Volleyball enrollment opened a transfer to Verification League. Destination practice-day question and required acknowledgment loaded. With a reason and practice day entered, Review was blocked by native validation on the unchecked required acceptance (valueMissing=true). Dialog closed without acceptance, preview or transfer submission. Full accepted-required-form transfer and changed-form recovery remain unverified in the browser.
