# Track B — sport logic and policies

Status: engine-switch-handoff-in-progress
Model: GPT-6 Sol
Branch: `track/b-logic`
Current: Phase 3 implementation continues after merging `rebuild/trunk` at `af353fc`; focused rollover, roster, staff eligibility and facility regressions are green, while the full phase gate is pending.
Requests to Track C (sprint wiring): mount `web/src/console/programs/routes.tsx`, `web/src/console/teams/routes.tsx`, and `web/src/console/facilities/routes.tsx` from `web/src/console/routes.tsx` when available; add Programs, Teams and Facilities links to the console home/navigation. Track C owns the web router and home shell under SPRINT.md.
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
Ready for integration: none — Phase 3 branch has not passed the sprint merge gate.
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

Phase 3 progress: date-based registration instants now preserve local wall time over DST; space hierarchy rejects children under future bookings and cycles, map links require HTTP(S), nested archive is recursive, availability updates are version-checked; roster capacity serializes on the team-season row and staff assignment calls F's eligibility gate. Focused Postgres suites pass (14 tests); typecheck passes.
Requests to other tracks: C — mount `web/src/console/{programs,teams,facilities}/routes.tsx` in `web/src/console/routes.tsx` and refresh OpenAPI after the B-owned availability PATCH route; QA — add the Phase 3 setup and rollover journeys from `11 Phase 3` on Chromium and WebKit mobile, with axe and 390px coverage; H — provide the volunteer-requirement rollover extras contract/table for `SeasonRolloverExtras`.
Pending Phase 3 gate: full tests, owned Playwright journeys, OpenAPI freshness after facilities PATCH, build and self-merge protocol. Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_b`, `PORT_OFFSET=2500`, Postgres `127.0.0.1:7932`.

## HANDOFF

- Done: the pre-existing Track B queues are recorded above. Phase 3 baseline work and the latest trunk merge are committed locally; this handoff commit captures the current follow-up edits. Branch is `track/b-logic`, currently based on merge commit `fc6d20a` which merged `rebuild/trunk` through `af353fc`.
- In progress, exact uncommitted implementation paths at handoff: `server/src/modules/facilities/module.ts`, `server/src/modules/facilities/routes.ts`, `server/src/modules/facilities/service.ts`, `server/src/modules/facilities/split-field.integration.test.ts`, `server/src/modules/rosters/service.ts`, `server/src/modules/seasons/module.ts`, `server/src/modules/seasons/phase3-acceptance.integration.test.ts`, `server/src/modules/seasons/routes.ts`, `server/src/modules/seasons/service.ts`, `server/src/modules/teams/service.ts`, `web/src/console/facilities/FacilitiesConsole.tsx`, `web/src/console/programs/ProgramConsole.tsx`, `web/src/console/programs/SeasonRollover.tsx`, and `web/src/console/teams/TeamConsole.tsx`. `docs/codex/tracks/B.md` contains this handoff and the current integration requests.
- Exact next steps: (1) review the committed diffs, especially the returning-team selection validation in `server/src/modules/seasons/service.ts`; a redundant membership check was identified for cleanup, while eligible team-season IDs are separately validated. (2) Run typecheck and targeted ESLint, then rerun the affected Postgres suites with `COMPOSE_PROJECT_NAME=athlentry_b`, `PORT_OFFSET=2500`, `DATABASE_ADMIN_URL=postgres://athlentry_admin@127.0.0.1:7932/athlentry_test`, and `DATABASE_APP_URL=postgres://athlentry_app@127.0.0.1:7932/athlentry_test`. (3) Complete remaining Phase 3 acceptance gaps and service/UI review; add targeted regressions for any fixes. (4) Resolve the wiring and journey requests below with the owning tracks. (5) Run the full gate and owned Playwright journeys through `~/athlentry-sprint/heavy.sh`; refresh generated OpenAPI only through Track C. (6) Once the branch gate is green, follow the current SPRINT self-merge protocol into `rebuild/trunk` and update this track file.
- Known failing or unverified tests: the focused season and facility Postgres suites most recently passed (2 files, 15 tests); targeted ESLint passed. Typecheck passed before the final small season-filter edit and should be rerun. The full suite and Phase 3 Playwright acceptance journeys are unverified/not yet available. An earlier full-suite attempt timed out in unrelated auth, compliance, communications, finance, and chat tests; rerun via `heavy.sh` before integration. No current targeted test failure is known.
- Open requests: Track C — mount `web/src/console/{programs,teams,facilities}/routes.tsx`, add console navigation, and regenerate OpenAPI for the facilities availability PATCH. Track QA — add Phase 3 setup and rollover journeys on Chromium and WebKit mobile, with axe and 390px coverage. Track H — provide the volunteer-requirement rollover extras contract/table used by `SeasonRolloverExtras`.
- Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_b`, `PORT_OFFSET=2500`; Postgres is `127.0.0.1:7932`.

HANDED OFF 11:35
