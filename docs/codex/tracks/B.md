# Track B — sport logic and policies

Status: Phase 3 in progress
Model: GPT-6 Sol
Branch: `track/b-logic`
Current: Track B candidate `15cc7e05` synced with trunk at `1e91bd6`; typecheck and lint pass. Full merge gate passed: `npm test` (912 passed, 1 skipped) and Chromium desktop (39 passed, 6 skipped). Date-sensitive fixtures ran at a fixed Chicago instant with Chicago Postgres sessions to keep local date-only values stable across UTC midnight.
Requests to Track E: Phase 5 checkout must consume B offering pricing `{ earlyPriceCents, earlyEndsAt, latePriceCents, lateStartsAt, installmentTemplateIds, siblingDiscountEligible }` and add-ons `{ key, name, priceCents, required, options: [{ key, label }] }`; windows are paired, use org-local wall times converted to instants, and early pricing ends before late pricing begins. The current checkout pricing source fails closed on these configured values.
Requests to Track QA: add and run the Phase 3 Chromium and WebKit-mobile wizard journey at 390 px with axe: volleyball season/program setup, three divisions, two offerings and an installment template, then team generation. The generated nested router now mounts the program route.
Requests to Track H: provide the rollover extras contract for copying volunteer requirements into the target season with their dates shifted and staff requirements pending revalidation; wire it through `SeasonRolloverExtras`.
Requests to Track C: compose optional `seasonRolloverExtras` contributions from registered modules and pass them to the seasons router; B's route now accepts the typed `SeasonRolloverExtras[]` contract. H should implement its volunteer requirement copier as one contribution.
Ready: Age/eligibility — `shared/src/sport/{age,eligibility}.ts`; 11 targeted tests, typecheck and lint green.
Ready: Recurrence — `shared/src/recurrence.ts`; 11 targeted tests across four timezones, typecheck and lint green.
Ready: Sport schema/results/stats/standings — 19 targeted tests, typecheck and lint green; template goldens still pending.
Ready: Pricing/fees — `shared/src/algorithms/{pricing,fees}.ts`; 11 targeted tests, typecheck and lint green.
Ready: Installments/invoice-state/capacity-math — 13 targeted tests, typecheck and lint green.
Ready: Pure policies (compliance, SafeSport, refunds, quiet hours, FCRA) — 15 targeted tests, typecheck and lint green.
Ready: Brackets — single/double elimination, byes, pool seeding and guarded advancement; 5 targeted tests, typecheck and lint green.
Ready: Schedule generator — circle pairings, 15-minute slots, hard/soft constraints, seeded local search and tournament reservations; 7 targeted tests, typecheck and lint green.
Ready: Team balancer — fixed groups, mutual friends, siblings, position coverage, snake draft and seeded swaps; 4 targeted tests, typecheck and lint green.
Ready: Evaluation — evaluator normalization, weighted criteria, group ranks and incomplete flags; 5 targeted tests, typecheck and lint green.
Ready: Proration — joining, withdrawal, tier changes and pauses by scheduled sessions; 6 targeted tests, typecheck and lint green.
Ready: Dunning/waitlist — local 10:00 retries, nonretryable stops, quiet-hour offers and capacity holds; 6 targeted tests, typecheck and lint green.
Ready: Logic edge review — refund rule validation and date parsing; bracket, finance, policy, recurrence, age and stat boundary tests.
Ready: Scoring variants — swim relay points, diving difficulty, cross-country/golf team totals, rugby bonuses and cricket net run rate; 46 golden files checked.
Ready: Property invariants — brackets, capacity, schedule, dunning, waitlist, evaluation, sport engine and all five policies.
Ready: Phase 1 task 10 core — pg-boss schema, executable job descriptors, 30-second worker heartbeat and redacted failed-job listing; isolated Postgres job completed.
Ready: Phase 1 task 15 core — OpenAPI 3.1 for 85 current operations with AST-verified route/operation coverage in both directions, required invitation Idempotency-Key headers and freshness check; closed error schema on auth/orgs, cursor pagination, transactional idempotency and version checks.
Ready: Phase 1 task 14 — append-only audit service, fail-closed Restricted-field redaction/read helper, role-scoped cursor API and functional console viewer.
Ready: Phase 1 task 13 — code-defined catalog, canonical and trunk-compatible account/organization inbox and preference aliases, audited writes, Postgres LISTEN/NOTIFY SSE, and portal notification center; mounted HTTP, SSE, tenancy and suspended-org tests pass.
Ready: Phase 1 task 9 — global platform staff/flags/impersonation/audit schema, org and plan controls, guarded read-only 60-minute impersonation, health API, functional `/platform` console and hidden-password bootstrap script; Postgres/HTTP and Chromium/WebKit acceptance pass.
Ready: Track E finance request `c537133` — weekly installments from `02 §L`, separate lost-dispute cents in invoice state, targeted shared tests and DEC-042.
Ready: Track F safety request `7f08458` — `credentials.expiry` registry runner with locked system actor, account-scoped notification trigger and F payload-safe inbox contract; targeted job/Postgres tests.
Ready: Track H communications request `5751eb2` — all 47 Phase 10 template types in the inbox catalog, SMS/push preferences, and a preferences-center link target for tokenized unsubscribe; targeted Postgres and Chromium/WebKit tests.
Integrated to `rebuild/trunk` in this self-merge: `1e91bd61..15cc7e05` (43 Track B commits). Contents: Phase 3 sport profiles, seasons/rollover, programs/divisions, offerings, teams/rosters/staff, facilities/spaces/availability, migrations 0210–0212, generated registry/nested-route/OpenAPI files, tests and shared sport updates.
Requests to other tracks: E — pass `disputedLostCents` separately from `refundedToMethodCents` to `deriveInvoiceState` and accept `{ kind: 'weekly', count }` in installment-template validation (2026-09-27).
Requests to other tracks: F — merge the compliance module declaration; `credentials.expiry` resolves to the B runner and direct notification inserts publish SSE through migration 0606 (2026-09-27).
Requests to other tracks: H — use `preferencesCenterPath(orgId)` after applying a tokenized unsubscribe; H-owned English/Spanish template bodies remain in the communications module (2026-09-27).
Requests to other tracks: A/C — move file-route request/response contracts and B module-local audit/notification/platform contracts to shared Zod schemas; merged file-route descriptors make OpenAPI generation pass.
Requests to other tracks: A/C — migrate A-owned mutable org routes to `expectedVersion`/version helpers and align C-owned files errors with the closed shared error envelope (`FILE_INVALID` is currently undeclared and uses a different JSON shape).
Integration dependencies: A/C-owned shared Zod request/response contracts, A-owned org version helper migration and C-owned files error envelope; mounted stream, portal aliases and audited impersonation are covered locally.
Self-review: Checked age and eligibility against `03 §3` and `15 §C8`; date rules reuse `shared/src/dates.ts`.
Self-review: Checked recurrence DST behavior against `15 §C1` across Chicago, New York, Phoenix and Honolulu.
Self-review: Checked money sequencing and state invariants against `20 §1–§5`; all arithmetic uses integer cents.
Self-review: Checked safety policies against `04 §4–§5`, refunds against Phase 5 task 7, and quiet hours against Phase 10.
Self-review: Initial logic suite, typecheck, lint and build green; first queue had no screens or routes requiring Playwright.
Self-review: 220 shared tests pass; Track B line coverage 95.08%; swim/diving/cross-country/golf/rugby/cricket variants checked against `03 §2, §5–§6`.
Self-review: Task 10 checked against `01 §6, §10`; pg-boss 12.1.1 migration applied and probe completed on isolated Postgres; generated registry refreshed.
Self-review: Task 15 checked against `01 §5` and Phase 1 task 15; concurrent idempotency replay tested on Postgres, existing auth/org routes and OpenAPI regeneration pass.
Self-review: Task 14 checked against `04 §6`; Restricted values are redacted at append and view, Restricted reads write in the read transaction, and owner/compliance/outsider access was tested on Postgres.
Self-review: Task 13 checked against `01 §5` and Phase 1 task 13; account-filtered SSE envelopes omit content, notifications and preferences use spine tables under `withOrg`, and concurrent preference updates serialize per account/category.
Self-review: Marketing notification preferences default disabled until explicit opt-in; operational and emergency preferences retain an enabled channel.
Self-review: Notification SSE revalidates its session on every 20-second heartbeat, ignores malformed envelopes and reloads the inbox on reconnect.
Self-review: B-owned audit/notification tenant reads carry the impersonation header; notification writes are hidden or disabled while impersonating, and banner end/expiry synchronizes the read-only state.
Self-review: Task 9 checked against Phase 1 task 9; platform writes use admin role where app grants are revoked, plan and org changes carry versions, last active super admin is protected, and impersonation requests log IDs without record payloads.
Self-review: Full unit/integration suite passes (550 tests, 1 existing skip) after E/F/H changes; typecheck, lint, build, registry and 109-operation OpenAPI generation pass; full Chromium/WebKit gate passes (26 pass, 4 existing skips) including platform, SMS/push preferences, mounted stream and axe.

Phase 3 progress: date-based registration instants and offering price windows preserve org-local wall time over DST; rollover preview lists copied divisions/offers/prices/add-ons/forms/waivers, while copy remains idempotent and excludes registrations, invoices, payments and results. Team creation supports manual and generated teams; roster capacity serializes on the team-season row, concurrent jersey uniqueness is database-enforced, and staff assignment calls F's eligibility gate. Facilities retain split-field exclusion, versioned availability, blackouts, suitability, public visibility and map URL validation. Generated nested routes include all three B screens and the OpenAPI freshness script passes after adding descriptors for all B-owned operations. Focused server/shared Phase 3 suites pass (132 tests); sport engine line coverage is 100%; typecheck and lint pass.
Pending Phase 3 acceptance: E checkout support for configured price windows/add-ons and the installment picker, H volunteer rollover extras, C registry composition of `seasonRolloverExtras`, and QA's Chromium/WebKit-mobile 390px axe journey. Phase 3 remains in progress until these cross-track items and the end-to-end acceptance journey are complete. Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_b`, `PORT_OFFSET=2500`, Postgres `127.0.0.1:7932`.

K verification (2026-09-27): previously reported `space_bookings` delete and schedule-role lookup failures no longer reproduce on the merged trunk suite; keep booking history and scoped role checks as the contract while preserving the Phase 3 acceptance work above.

Request from K (2026-09-27): in `web/src/console/classes/AcademyConsoleScreen.tsx:821`, `useQueries` starts one `GET /classes/orgs/:orgId/offerings/:offeringId/schedules` per offering on every screen mount, including when the Overview tab is selected. The Phase 15 Northstar fixture has 40 offerings; Chromium trace captured all 40 requests still without responses and later console requests pending, leaving populated store content absent in the same browser journey. Please defer schedule reads until the relevant tab/offering is selected or provide a bounded aggregate endpoint so the 40-item fixture can render alongside other console areas.
