# Track G — schedule

Implementation commits: `10dde5b`, `e26dee4`, `074b533`, `535746f`, `2bc22b6`, and `dc661ea`. Track notes: `c4454b4`, `5970856`, `6c60d66`. Branch: `track/g-schedule`, local only (not pushed).

Local integration range: `rebuild/trunk..track/g-schedule` (not pushed).

Status: working; Phase 8/9 acceptance and the full merge gate remain incomplete.

## Owned work and progress

- [x] G migration range `3000–3999` currently contains migrations `3000–3017`; on the isolated `athlentry_g` stack these and dependency migrations `0605`/`0606` are applied. Tenant-scoped services use `withOrg`.
- [x] Phase 9 officials acceptance integration test: ten games each crewed with referee + two assistants, one decline, reassignment to the same position, and a pay batch totaling $1,395 across fees plus mileage. The test exposed a defect: declined/no-show assignments permanently blocked the position; the occupancy check and `official_assignments_active_position_idx` now hold only `offered`/`accepted`/`confirmed` (migration `3017`).
- [x] Phase 9 timed-meet acceptance integration test: 40 swimmers across six events seeded into heat/lane slots, timed results with ties sharing places, and team scores rolled up from configured place points. The test exposed two defects fixed here: `createContest` wrote the invalid stage `tournament` (now constrained to the data-model enum; seeded bracket matches persist as `playoff`), and person entrants had no team attribution (now resolved through active program roster entries; `listContestResults` returns `teamScores`).
- [x] Phase 8 ICS acceptance: the calendar feed is now parsed with `ical.js` and asserted as a VCALENDAR containing one VEVENT with stable UID, moved `DTSTART`, and version-matched `SEQUENCE`.
- [x] Phase 8 G-owned services/UI: facilities and spaces, recurring series edits, conflict rules and overrides, allocations, generator jobs/reports, manual shift/swap, CSV import/export, publish/closure/reschedule operations, ICS, resource calendar drag/drop and keyboard moves, and facility pages.
- [x] Coach practice slot picker: team-scoped coaches can request an open allocated recurring slot; scheduler approval converts the reservation into a draft practice event without colliding with the space-booking exclusion constraint.
- [x] Phase 9 G-owned services/UI: attendance/RSVP, offline coach game-day screen, results and stat workflows, standings snapshots/visibility, timed meet assignments, pools/brackets/tournament scheduling, officials assignment/pay, and season-end operations.
- [x] Browser print/PDF output for schedules, results, standings and tournament brackets; safer CSV quoting/formula escaping and location round-trip; named standings rows plus visibility/config in staff UI; team-stat aggregation and public athlete personal-best views; and persistence/visibility regression tests.
- [x] Closure recipient lookup includes accounts linked to active officials assigned to the closed event; access integration regression passes.
- [x] Emergency closure batches become due immediately; routine schedule-change batches retain their 15-minute window.
- [x] Added a 13-team double-elimination acceptance regression and fixed the shared bracket algorithm to propagate bye winners and empty loser outcomes until the if-necessary final is playable.
- [x] Fixed the 48-team league schedule acceptance: candidate feasibility no longer rescans all assigned games inside each team check, and a deterministic Euler orientation keeps every scheduled team within one home/away game.
- [x] Added versioned program `statsEnabled` settings, staff-only configuration, stat entry fields, program/division leaderboards, and enabled/public filtering for team summaries and athlete personal bests; stat corrections replace the contest's stat lines.
- [x] Schedule mutations now include the required same-origin request marker, and the season-end award list qualifies tenant columns after joining people and teams.
- [x] Schedule event updates no longer apply create-only defaults to omitted fields; the published-event edit regression preserves publication and participants. CSV preview counts valid rows, and reschedule slots are serialized as JSONB; database error codes outside the public API contract safely map to `INTERNAL_ERROR`.
- [x] Schedule console and portal routes export the names expected by the generated nested-route registry, so they mount in the app router.
- [x] Family RSVP portal writes include the same-origin request marker; guardian RSVP persists for a rostered athlete and passes the Chromium/WebKit mobile browser journey.
- [x] Coach game-day attendance and result writes include the same-origin request marker; offline attendance syncs while a concurrently changed result remains queued with a visible conflict.
- [x] Lineup suspension checks now call Track F's discipline policy. The save transaction commits the policy's audit event before returning the 409 conflict; an integration test covers both the denial and durable audit record.
- [x] `npm run registry` regenerated 20 server modules, 6 integrations, 7 web features and nested routes; `npm run openapi` documents the program-stat settings and leaderboard APIs.

## Verification

- [x] `npm run typecheck` and `npm run lint` passed after syncing trunk through `2ac58d6`; post-fix typecheck and targeted ESLint pass.
- [x] Production `npm run build` passed after the final attendance audit-boundary edit.
- [x] Current focused database regressions pass: officials crew/pay acceptance, timed-meet acceptance, ICS parser checks, scheduling integration (DST, closures, moved-game ICS) and access integration: 6 files / 11 tests green after the latest fixes.
- [x] Reviewed and tested WIP commit `34ceaea`: contests/standings integration suites pass (4 files / 5 tests); all 50 seeded contest formats validate and finalize. The regression verifies configured templates persist program and division snapshots, while unconfigured sports finalize without snapshots and return a 409 for standings reads. Typecheck and full lint pass.
- [x] Schedule export/calendar and public standings component tests: 3 files / 8 tests passed.
- [x] Shared algorithm tests pass: 14/14; focused G generator/bracket acceptance tests pass: 2/2. The 48-team case is below the 60-second acceptance bound.
- [x] Cached per-run timezone and epoch conversions in schedule candidate checks; the 48-team/168-game generator acceptance now takes 0.53 seconds locally with its 60-second assertion unchanged, and all 7 shared schedule-generator tests pass.
- [x] Schedule generator browser journey passes Chromium desktop and WebKit mobile with axe: it renders unscheduled explanations, discards one run, then applies a scheduled game and verifies persisted run/event state.
- [x] Recurrence-series browser journey passes Chromium desktop and WebKit mobile with axe: it creates three weekly events, edits the selected and following occurrences, and verifies the preserved event, cancellations, replacement series, and changed duration.
- [x] Schedule tools browser journey passes Chromium desktop and WebKit mobile with axe: publish and edit, home/away swap, batched change notification record, CSV export/import, and reschedule request/approval with database assertions.
- [x] Public facility page browser journey passes Chromium desktop and WebKit mobile with axe: staff publishes a facility listing, adds a bookable space, and the public page displays parking notes and the space.
- [x] All seven G-owned schedule browser journeys pass together on Chromium desktop and WebKit mobile with axe: 14/14 tests after syncing the latest trunk commit.
- [x] Kept the ten-game officials crew/pay regression below Vitest's unchanged five-second timeout under load by running its independent assignment offers and responses concurrently; three focused runs passed.
- [x] `npm run typecheck` and `npm run lint` pass after syncing `rebuild/trunk` through `af353fc` (merge `70b7c2d`).
- [x] Updated scheduling access integration passes, including official closure recipients and emergency batch timing.
- [x] Program statistic settings, leaderboard aggregation, enabled/public filters, private-stat staff access, and optimistic-concurrency integration regression pass against the isolated Postgres stack.
- [x] Season-award listing query regression passes against isolated Postgres after qualifying joined table columns.
- [x] Statistics configuration, contest creation, finalized score with persisted per-team stats, facility closure preview and postponement, public leaderboard, and public standings snapshot Playwright journey passes on Chromium desktop and WebKit mobile with axe and no schedule-page alerts.
- [x] Latest standings table follow-up adds a keyboard-focusable named scroll region; focused schedule-stats journey passes Chromium desktop and WebKit mobile, and targeted ESLint plus `npm run typecheck` pass.
- [x] Family guardian RSVP browser journey passes on Chromium desktop and WebKit mobile with axe; it caught and fixed the portal's missing same-origin request marker.
- [x] Coach allocation browser journey passes on Chromium desktop and WebKit mobile with axe: linked head coach requests an allocated slot, access to another team is denied, and scheduler approval creates the practice event.
- [x] Offline coach game-day journey passes on Chromium desktop and WebKit mobile with axe: attendance and score queue offline, attendance syncs after reconnect, and the newer server score is preserved while the score conflict remains visible.
- [x] Chromium + WebKit mobile baseline E2E: 38 passed, 4 failed, 4 skipped; failures were unrelated sign-in, ownership-transfer and people journeys, and no G schedule journey ran.
- [x] Lock-protected merge gate against `rebuild/trunk` through `2ac58d6`: typecheck and full lint passed; `heavy.sh npm test` passed 803 tests (1 skipped); full Chromium desktop Playwright passed 28 tests (4 skipped).
- [x] Lock-protected merge gate on 2026-09-27 after syncing OPS trunk through `f091afc`: typecheck and full lint passed; `heavy.sh npm test` passed 819 tests (1 skipped); full Chromium desktop Playwright passed 30 tests (4 skipped).
- [x] After the latest schedule fixes, the focused scheduling server suite passes (6 files / 12 tests), the focused event schema/error tests pass (5 tests), and `npm run typecheck` plus full `npm run lint` pass.
- [ ] Prior lock-protected merge attempt stopped because `server/src/modules/officials/service.integration.test.ts` timed out at five seconds; the independent assignment/response operations are now concurrent and three focused default-timeout runs passed. Retry the full merge gate after syncing trunk.
- [ ] Phase 8/9 browser acceptance remains incomplete; eight G-owned journeys cover recurrence-series edits, schedule tools/manual changes/CSV/reschedules, public facility pages, statistics/results/facility closure, generator apply/discard and explanations, coach allocation requests, family RSVP, and offline game-day sync on Chromium and WebKit mobile. The console and portal routes mount via the generated nested-route registry.
- [ ] Full gates remain blocked by missing Phase 8/9 browser journeys, discipline result/game-served integration, notification email fan-out, volunteer closure recipients, the facility image serving contract, and baseline WebKit failures. Do not mark ready until browser journeys and all acceptance criteria pass.

## Cross-track requests and blockers

- **Track C (sprint wiring owner):** include the nested schedule routes in console/portal navigation and coordinate the remaining Phase 8/9 Chromium + WebKit mobile journeys with axe. The public facility API currently returns a layout file ID and the page renders facility details, directions, parking and spaces, but cannot safely render the image without a public serving contract for approved facility layout files.
- **Track A:** investigate the four baseline Playwright failures in sign-in, ownership transfer and the people flow before the full browser gate.
- **Track B:** align shared `contestStageSchema` with `02-DATA-MODEL.md`: it accepts `tournament` (rejected by `contests_stage_check`) and omits `championship`/`consolation`/`exhibition`; G's service/routes now follow the data-model enum. Generator fairness and double-elimination bye progression fixes are in G's current branch and need review with the shared-algorithm owner before integration.
- **Track H:** expose volunteer assignments by event so emergency closure notifications can reach affected volunteers. No volunteer assignment module or table is present on current trunk.
- **Track F / discipline service owner:** expose the transaction-scoped result-to-discipline creation and finalized-game-served operation needed for automatic card/ejection suspensions. The current service provides `assertNotSuspendedForLineup`, which G calls, but does not provide `createFromContestResult` or automatic games-served counting. Result finalization therefore rejects card finalization with an explicit service-unavailable conflict instead of silently skipping discipline enforcement.
- **Track B / C notifications integration:** connect emergency closure notification events to the notification fan-out contract. G batches changes and emits through Track B's notification service; that service currently marks only `in_app`, so the required Mailpit email journey is not yet evidenced. G must not implement a separate messaging pipeline.

## Requests from SEC

- SEC-KNIP-G: triage `npm run knip` findings in G-owned scheduling/officials paths: unused `web/src/console/schedule/nav.ts` and `web/src/portal/schedule/nav.ts`; unused exports `testComplianceForOfficial`, `generatorInputFromConstraints`, `scheduleGenerationJob`, `scheduleSeriesHorizonJob`, `scheduleBatchEmitJob`, `runScheduleGeneration`, `extendRecurringSeries`, `routeError`, `eventKindSchema`, `eventStatusSchema`, `participantInputSchema`, `eventCreateSchema`, `eventIdResponseSchema`, `conflictReportSchema`, `eventSeriesSchema`, `importScheduleFile`, `importScheduleCsv`, and `escapeHtml`; unused related types `EventCreateInput`, `EventSeriesCreateInput`, `SeriesEditInput`, `SpaceAvailabilityCreateInput`, `SpaceBlackoutCreateInput`, `BlackoutRequestInput`; duplicate export `eventSeriesCreateSchema|eventSeriesSchema` (2026-09-27).

## Decisions and review

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, Phase 8/9 in `11`, `02 §H/I/J/Q`, and `05 §6`.
- G decisions are `DEC-082–096` and `DEC-100–108` in `docs/codex/DECISIONS.md`; Track A decisions `DEC-097–099` remain intact.
- Latest integration: G passed the lock-protected merge gate and was merged into `rebuild/trunk` on 2026-09-27; local only, not pushed.
- Do not mark ready or write “Track G complete” until the outstanding cross-track contracts, schedule journeys and full gates pass.
