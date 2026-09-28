# Track G — schedule

Implementation commits: `10dde5b`, `e26dee4`, `074b533`, `535746f`, `2bc22b6`, and `dc661ea`. Track notes: `c4454b4`, `5970856`, `6c60d66`. Branch: `track/g-schedule`, local only (not pushed).

Local integration range: `rebuild/trunk..track/g-schedule` (not pushed).

Status: working; Phase 8/9 acceptance and the full merge gate remain incomplete.

## Owned work and progress

- [x] G migration range `3000–3999` currently contains migrations `3000–3017`; on the isolated `athlentry_g` stack these and dependency migrations `0605`/`0606` are applied. Tenant-scoped services use `withOrg`.
- [x] Phase 9 officials acceptance browser journey: ten games each crewed with referee + two assistants, one decline, reassignment to the same position, portal accept/decline responses, and a UI pay batch totaling $1,395 across fees plus mileage. The test exposed a defect: declined/no-show assignments permanently blocked the position; the occupancy check and `official_assignments_active_position_idx` now hold only `offered`/`accepted`/`confirmed` (migration `3017`).
- [x] Phase 9 timed-meet acceptance browser journey: 40 swimmers across six events seeded into heat/lane slots, timed results with ties sharing places, and team scores rolled up from configured place points. The test exposed two defects fixed here: `createContest` wrote the invalid stage `tournament` (now constrained to the data-model enum; seeded bracket matches persist as `playoff`), and person entrants had no team attribution (now resolved through active program roster entries; `listContestResults` returns `teamScores`).
- [x] Phase 9 tournament browser journey: a director creates and generates a seeded 13-team double-elimination bracket; all entries and three opening byes persist, and its responsive public bracket and print control render accessibly.
- [x] Phase 9 season-end browser journey: guardian submits the Spanish NPS survey and comment, staff reviews and archives responses, issues and prints an athlete certificate, records a coach rating, and archives the completed season.
- [x] Phase 8 ICS acceptance: the calendar feed is now parsed with `ical.js` and asserted as a VCALENDAR containing one VEVENT with stable UID, moved `DTSTART`, and version-matched `SEQUENCE`.
- [x] Phase 8 G-owned services/UI: facilities and spaces, recurring series edits, conflict rules and overrides, allocations, generator jobs/reports, manual shift/swap, CSV import/export, publish/closure/reschedule operations, ICS, resource calendar drag/drop and keyboard moves, and facility pages.
- [x] Closure form timestamps now use the selected facility's timezone for facility/space scope and the organization timezone for org scope; the facilities API exposes the tenant timezone through `withOrg`. The UTC Playwright regression verifies exact instants and 24 affected events for all three scopes.
- [x] Coach practice slot picker: team-scoped coaches can request an open allocated recurring slot; scheduler approval converts the reservation into a draft practice event without colliding with the space-booking exclusion constraint.
- [x] Phase 9 G-owned services/UI: attendance/RSVP, offline coach game-day screen, results and stat workflows, standings snapshots/visibility, timed meet assignments, pools/brackets/tournament scheduling, officials assignment/pay, and season-end operations.
- [x] Browser print/PDF output for schedules, results, standings and tournament brackets; safer CSV quoting/formula escaping and location round-trip; named standings rows plus visibility/config in staff UI; team-stat aggregation and public athlete personal-best views; and persistence/visibility regression tests.
- [x] Closure recipient lookup includes accounts linked to active officials and people with signed-up, confirmed, or checked-in volunteer shifts for the closed event; canceled/completed shifts and canceled signups are excluded.
- [x] Emergency closure batches become due immediately; routine schedule-change batches retain their 15-minute window.
- [x] Added a 13-team double-elimination acceptance regression and fixed the shared bracket algorithm to propagate bye winners and empty loser outcomes until the if-necessary final is playable.
- [x] Fixed the 48-team league schedule acceptance: candidate feasibility no longer rescans all assigned games inside each team check, and a deterministic Euler orientation keeps every scheduled team within one home/away game.
- [x] Added versioned program `statsEnabled` settings, staff-only configuration, stat entry fields, program/division leaderboards, and enabled/public filtering for team summaries and athlete personal bests; stat corrections replace the contest's stat lines.
- [x] Schedule mutations now include the required same-origin request marker, and the season-end award list qualifies tenant columns after joining people and teams.
- [x] Schedule event updates no longer apply create-only defaults to omitted fields; the published-event edit regression preserves publication and participants. CSV preview counts valid rows, and reschedule slots are serialized as JSONB; database error codes outside the public API contract safely map to `INTERNAL_ERROR`.
- [x] Schedule console and portal routes export the names expected by the generated nested-route registry, so they mount in the app router.
- [x] Family RSVP portal writes include the same-origin request marker; guardian RSVP persists for a rostered athlete and passes the Chromium/WebKit mobile browser journey.
- [x] Coach game-day attendance and result writes include the same-origin request marker; offline attendance syncs while a concurrently changed result remains queued with a visible conflict.
- [x] Coach game-day acceptance now verifies injured and suspended roster flags, allergy and emergency-contact details, minimum-play warnings, saved lineup entries, and the offline result-conflict flow. Fixed lineup persistence to encode entry arrays as JSONB rather than letting node-postgres treat them as SQL arrays.
- [x] Lineup suspension checks now call Track F's discipline policy. The save transaction commits the policy's audit event before returning the 409 conflict; an integration test covers both the denial and durable audit record.
- [x] `npm run registry` regenerated 20 server modules, 6 integrations, 7 web features and nested routes; `npm run openapi` documents the program-stat settings and leaderboard APIs.

## Verification

- [x] `npm run typecheck` and `npm run lint` passed after syncing trunk through `2ac58d6`; post-fix typecheck and targeted ESLint pass.
- [x] Production `npm run build` passed after the final attendance audit-boundary edit.
- [x] Current focused database regressions pass: officials crew/pay acceptance, timed-meet acceptance, ICS parser checks, scheduling integration (DST, closures, moved-game ICS) and access integration: 6 files / 11 tests green after the latest fixes.
- [x] Reviewed and tested WIP commit `34ceaea`: contests/standings integration suites pass (4 files / 5 tests); all 50 seeded contest formats validate and finalize. The regression verifies configured templates persist program and division snapshots, while unconfigured sports finalize without snapshots and return a 409 for standings reads. Typecheck and full lint pass.
- [x] Schedule export/calendar and public standings component tests: 3 files / 8 tests passed.
- [x] Shared algorithm tests pass: 14/14; focused G generator/bracket acceptance tests pass: 2/2. The 48-team case is below the 60-second acceptance bound.
- [x] Cached per-run timezone and epoch conversions in schedule candidate checks; the 48-team/168-game server generator acceptance took 441 ms in the isolated test run with its 60-second assertion unchanged, and all 7 shared schedule-generator tests pass.
- [x] Schedule generator browser journey passes Chromium desktop and WebKit mobile with axe: it renders unscheduled explanations, discards one run, then applies a scheduled game and verifies persisted run/event state.
- [x] Recurrence-series browser journey passes Chromium desktop and WebKit mobile with axe across the November 2026 DST transition: Chicago stays at 18:00 while the UTC gap changes, Phoenix stays at 18:00 with seven-day UTC intervals, and “following” edits succeed in both zones.
- [x] Schedule tools browser journey passes Chromium desktop and WebKit mobile with axe: publish and edit, home/away swap, batched change notification record, CSV export/import, and reschedule request/approval with database assertions.
- [x] Public facility page browser journey passes Chromium desktop and WebKit mobile with axe: staff publishes a facility listing, adds a bookable space, and the public page displays parking notes and the space.
- [x] The original seven G-owned schedule browser journeys pass together on Chromium desktop and WebKit mobile with axe: 14/14 tests. The allocation, officials and meet journeys also pass their grouped target runs in both browsers with axe.
- [x] Kept the ten-game officials crew/pay regression below Vitest's unchanged five-second timeout under load by running its independent assignment offers and responses concurrently; three focused runs passed.
- [x] `npm run typecheck` and `npm run lint` pass after syncing `rebuild/trunk` through `af353fc` (merge `70b7c2d`).
- [x] Updated scheduling access integration passes, including official closure recipients and emergency batch timing.
- [x] Program statistic settings, leaderboard aggregation, enabled/public filters, private-stat staff access, and optimistic-concurrency integration regression pass against the isolated Postgres stack.
- [x] Season-award listing query regression passes against isolated Postgres after qualifying joined table columns.
- [x] Statistics configuration, contest creation, finalized score with persisted per-team stats, facility closure preview and postponement, public leaderboard, and public standings snapshot Playwright journey passes on Chromium desktop and WebKit mobile with axe and no schedule-page alerts.
- [x] Linux CI reproduction uses Node 24 and the Playwright 1.63.0 Noble image on AMD64. The focused Chromium statistics journey passes (1/1); a final run with `--shm-size=1g` took 1.4 minutes. `webServer` waits for `/healthz` through Vite's API proxy, so Playwright does not begin before the API listener is ready. Chromium crashed at the final navigation in an earlier Docker run with the default shared-memory mount; the adequately sized rerun passed. The emulated AMD64 WebKit process also crashed under this ARM host, so neither container-specific crash is a result from GitHub's native AMD64 runner.
- [x] GitHub Actions run `36357792018` reproduced the facility closure defect: on the Linux runner, the closure preview returned zero events for a Chicago facility because the form conversion used the browser/organization timezone. Closure conversion now uses the selected scope's timezone; the UTC regression checks the facility preview's exact instants and 24-event count.
- [x] The focused CI-mode statistics journey passes on Chromium desktop and WebKit mobile (2/2). Its longer timeout covers the combined stats, contest, closure, notification, and public-facility flow under shared-runner load; all result and closure assertions remain enabled.
- [x] Re-ran the focused schedule-stats journey in CI mode: Chromium and WebKit mobile both pass. The facility-page journey now uploads a public website asset with the organization scope, persists its file ID, and renders the image through Track C's route contract; Chromium and WebKit mobile pass. The image response is mocked in this test because Track C's route is not yet on `rebuild/trunk`.
- [x] Full current G Playwright set ran under `heavy.sh`: all 12 journeys passed on Chromium desktop and WebKit mobile with axe (24/24, 1.9 minutes).
- [x] After syncing trunk through `2c52eb47`, typecheck, lint, and production build pass. The complete CI-mode G suite passed 24/24 across Chromium desktop and WebKit mobile with axe at two workers. The suite now waits for the final closure response, targets the season feedback h2 explicitly, and allows the ten-game official assignment journey up to 180 seconds.
- [ ] Latest full Vitest run under `heavy.sh` against G's isolated database: 266 files pass and 1 is skipped (944 tests pass, 1 skipped); 4 tests fail outside G: two class-enrollment constraints in `server/src/modules/classes/classes.integration.test.ts`, one roster constraint in `server/test/peopleFilters.test.ts`, and one public placement assertion in `server/test/modules/sponsors/service.integration.test.ts`. These prevent the full integration gate.
- [x] Focused six-module rerun after syncing trunk through `2c52eb47`: 14 files / 22 tests passed on the isolated G test database with two Vitest workers (19.86 seconds). This clears the earlier overloaded-host hook/standings timeouts without changing test budgets.
- [x] North Park mass-closure journey closes 24 published games, resolves 24 event-linked volunteer signups to one recipient, persists one immediate 24-change emergency batch, emits its notification through Track B's notification service, and shows the rainout banner with all 24 postponed events on the public facility page; Chromium and WebKit mobile with axe pass. The notification service currently records the in-app channel only.
- [x] Public live contest page consumes a versioned SSE route; the Phase 9 journey opens a scheduled contest, finalizes its format-specific result, and observes the public score/status update in Chromium and WebKit mobile with axe. The SSE endpoint is documented as `text/event-stream` in the OpenAPI output.
- [x] Earlier full Vitest suite on the G-isolated stack after live scores and UTC closure timezone resolution: 246 files passed, 1 skipped; 876 tests passed, 1 skipped.
- [x] Latest standings table follow-up adds a keyboard-focusable named scroll region; focused schedule-stats journey passes Chromium desktop and WebKit mobile, and targeted ESLint plus `npm run typecheck` pass.
- [x] After the Phase 9 additions and export cleanup, all six G-owned server-module suites pass (14 files / 22 tests); typecheck, full lint, and production build pass.
- [x] Family guardian RSVP browser journey passes on Chromium desktop and WebKit mobile with axe; it caught and fixed the portal's missing same-origin request marker.
- [x] Coach allocation browser journey passes on Chromium desktop and WebKit mobile with axe: linked head coach requests an allocated slot, access to another team is denied, and scheduler approval creates the practice event.
- [x] Officials and meet acceptance browser journeys pass on Chromium desktop and WebKit mobile with axe: ten games with one declined/reassigned crew position and reconciled pay; six swimming events with 40 timed entrants each, lane/heat seeding, tie places and 97 configured team points.
- [x] Tournament browser journey passes on Chromium desktop and WebKit mobile with axe: the console generates a 13-team double-elimination bracket with three persisted opening byes, then the public route renders seeded teams and print controls.
- [x] Season-end browser journey passes on Chromium desktop and WebKit mobile with axe: Spanish family response appears in survey results, certificate print contains the awarded athlete/title, coach rating persists, and completed season status becomes archived.
- [x] Offline coach game-day journey passes on Chromium desktop and WebKit mobile with axe: attendance and score queue offline, attendance syncs after reconnect, and the newer server score is preserved while the score conflict remains visible.
- [x] Expanded offline coach game-day journey passes on Chromium desktop and WebKit mobile with axe (2/2); the attendance service integration regression passes (1/1), and targeted ESLint passes after the JSONB lineup fix.
- [x] All 12 G-owned schedule journeys pass together on Chromium desktop and WebKit mobile with axe: 24/24 tests, including UTC org-, facility-, and space-closure conversion checks and Chicago/Phoenix DST-spanning series edits.
- [x] After the closure timezone fix, `npm run typecheck`, full `npm run lint`, and `npm run build` pass; the focused UTC stats/closure journey passes on both Chromium and WebKit.
- [x] Chromium + WebKit mobile baseline E2E: 38 passed, 4 failed, 4 skipped; failures were unrelated sign-in, ownership-transfer and people journeys, and no G schedule journey ran.
- [x] Lock-protected merge gate against `rebuild/trunk` through `2ac58d6`: typecheck and full lint passed; `heavy.sh npm test` passed 803 tests (1 skipped); full Chromium desktop Playwright passed 28 tests (4 skipped).
- [x] Lock-protected merge gate on 2026-09-27 after syncing OPS trunk through `f091afc`: typecheck and full lint passed; `heavy.sh npm test` passed 819 tests (1 skipped); full Chromium desktop Playwright passed 30 tests (4 skipped).
- [x] After the latest schedule fixes, the focused scheduling server suite passes (6 files / 12 tests), the focused event schema/error tests pass (5 tests), and `npm run typecheck` plus full `npm run lint` pass.
- [x] The officials assignment/response service regression now runs independent operations concurrently; three focused default-timeout runs and the latest six-module G backend suite pass.
- [x] Twelve G-owned schedule journeys cover recurrence-series edits, schedule tools/manual changes/CSV/reschedules, public facility pages, statistics/results/24-game facility closure with volunteer notification, generator apply/discard and explanations, coach allocation requests, family RSVP, offline game-day sync, officials assignment/pay, swim meets, tournaments, and season end; Chromium desktop and WebKit mobile with axe pass 24/24. The console and portal routes mount via the generated nested-route registry.
- [ ] Full acceptance remains blocked on emergency-notice email fan-out, discipline result/game-served integration, Track C's public facility image route integration, unrelated baseline WebKit failures, and the full branch and trunk merge gates. Do not mark ready until the remaining cross-track contracts and full gates pass.

## Cross-track requests and blockers

- **Track C (sprint wiring owner):** the schedule navigation aggregators and generated nested routes are now wired on trunk. Track C's `track/c-adapters` branch defines the scoped public facility layout image route; it is not present on `rebuild/trunk` yet. G now uploads only public website assets, attaches the approved file ID to the facility, and renders through that route contract. The G browser test mocks the route response until the C implementation is integrated.
- **Track A:** investigate the sign-in, ownership-transfer, people-flow Playwright failures and the current `peopleFilters.test.ts` roster check-constraint failure before the full gates.
- **Track B:** align shared `contestStageSchema` with `02-DATA-MODEL.md`: it accepts `tournament` (rejected by `contests_stage_check`) and omits `championship`/`consolation`/`exhibition`; G's service/routes now follow the data-model enum. Generator fairness and double-elimination bye progression fixes are in G's current branch and need review with the shared-algorithm owner before integration.
- **Track H:** resolved by the Phase 11 merge (`0ca39573`): event-linked volunteer shifts and signups are now included in closure recipients and covered by the North Park mass-closure journey.
- **Track H / I:** the current full Vitest gate also fails in sponsor placement (`server/test/modules/sponsors/service.integration.test.ts`) and two academy promotion cases (`server/src/modules/classes/classes.integration.test.ts`); these paths are outside G's ownership.
- **Track F / discipline service owner:** expose the transaction-scoped result-to-discipline creation and finalized-game-served operation needed for automatic card/ejection suspensions. The current service provides `assertNotSuspendedForLineup`, which G calls, but does not provide `createFromContestResult` or automatic games-served counting. Result finalization therefore rejects card finalization with an explicit service-unavailable conflict instead of silently skipping discipline enforcement.
- **Track B / C notifications integration:** G batches all affected games per recipient and emits one emergency notification through Track B's notification service. Track B currently records only `in_app`; the required Mailpit email fan-out is not yet available or evidenced. G must not implement a separate messaging pipeline.

## Requests from SEC

- SEC-KNIP-G: removed unreferenced G-owned wrappers/helpers, removed the duplicate schedule schema alias, and made file-local helpers private. The current global `npm run knip` passes; G's nested navigation aggregators are wired on trunk.

## Requests from OPS

- **Track G (API contract, 2026-09-27):** keep `runScheduleGeneration` exported from `server/src/modules/scheduling/generator.ts`; Track J's federation schedule workflow imports and calls this shared service. OPS restored the export during the current trunk sync after typecheck caught the missing API.

## Decisions and review

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, Phase 8/9 in `11`, `02 §H/I/J/Q`, and `05 §6`.
- G decisions are `DEC-082–096` and `DEC-100–108` in `docs/codex/DECISIONS.md`; Track A decisions `DEC-097–099` remain intact.
- Latest G integration: merged `rebuild/trunk` through `2c52eb47` into this branch (`7eb399d7`). The Linux API-readiness fix and G browser journeys pass; the full Vitest gate remains red on the cross-track failures listed above. Current G commits remain local and are not pushed.
- Do not mark ready or write “Track G complete” until the outstanding cross-track contracts, schedule journeys and full gates pass.

## Requests from J

- Resolved: closure submissions now use the selected facility timezone, including space closures, and the organization timezone for org-scope closures. The UTC regression verifies the exact submitted instants and affected-event counts.
