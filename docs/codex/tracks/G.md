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
- [x] Phase 9 G-owned services/UI: attendance/RSVP, offline coach game-day screen, results and stat workflows, standings snapshots/visibility, timed meet assignments, pools/brackets/tournament scheduling, officials assignment/pay, and season-end operations.
- [x] Browser print/PDF output for schedules, results, standings and tournament brackets; safer CSV quoting/formula escaping and location round-trip; named standings rows plus visibility/config in staff UI; team-stat aggregation and public athlete personal-best views; and persistence/visibility regression tests.
- [x] Closure recipient lookup includes accounts linked to active officials assigned to the closed event; access integration regression passes.
- [x] Emergency closure batches become due immediately; routine schedule-change batches retain their 15-minute window.
- [x] Added a 13-team double-elimination acceptance regression and fixed the shared bracket algorithm to propagate bye winners and empty loser outcomes until the if-necessary final is playable.
- [x] Fixed the 48-team league schedule acceptance: candidate feasibility no longer rescans all assigned games inside each team check, and a deterministic Euler orientation keeps every scheduled team within one home/away game.
- [x] Added versioned program `statsEnabled` settings, staff-only configuration, stat entry fields, program/division leaderboards, and enabled/public filtering for team summaries and athlete personal bests; stat corrections replace the contest's stat lines.
- [x] Lineup suspension checks now call Track F's discipline policy. The save transaction commits the policy's audit event before returning the 409 conflict; an integration test covers both the denial and durable audit record.
- [x] `npm run registry` regenerated 18 server modules, 6 integrations and 6 web features; `npm run openapi` regenerated API documentation, including the personal-best endpoint.

## Verification

- [x] `npm run typecheck` and `npm run lint` passed after syncing trunk through `9b5b430` (merge `7bd217f`); post-edit typecheck and targeted ESLint pass.
- [x] Production `npm run build` passed after the final attendance audit-boundary edit.
- [x] Current focused database regressions pass: officials crew/pay acceptance, timed-meet acceptance, ICS parser checks, scheduling integration (DST, closures, moved-game ICS) and access integration: 6 files / 11 tests green after the latest fixes.
- [x] Reviewed and tested WIP commit `34ceaea`: contests/standings integration suites pass (4 files / 5 tests); all 50 seeded contest formats validate and finalize. The regression verifies configured templates persist program and division snapshots, while unconfigured sports finalize without snapshots and return a 409 for standings reads. Typecheck and full lint pass.
- [x] Schedule export/calendar and public standings component tests: 3 files / 8 tests passed.
- [x] Shared algorithm tests pass: 14/14; focused G generator/bracket acceptance tests pass: 2/2. The 48-team case is below the 60-second acceptance bound.
- [x] `npm run typecheck` and `npm run lint` pass after syncing `rebuild/trunk` through `af353fc` (merge `70b7c2d`).
- [x] Updated scheduling access integration passes, including official closure recipients and emergency batch timing.
- [x] Program statistic settings, leaderboard aggregation, enabled/public filters, private-stat staff access, and optimistic-concurrency integration regression pass against the isolated Postgres stack.
- [x] Chromium + WebKit mobile baseline E2E: 38 passed, 4 failed, 4 skipped; failures were unrelated sign-in, ownership-transfer and people journeys, and no G schedule journey ran.
- [ ] Previous lock-protected full merge gate (before the latest algorithm fixes): typecheck/lint passed; `heavy.sh npm test` reported 757 passed, 1 skipped, 2 failed. Both failures are now fixed and pass in targeted suites; rerun the full gate before integration.
- [ ] Phase 8/9 Chromium + WebKit mobile schedule journeys with axe remain outstanding. No G journeys currently exist and the registered schedule routes are not mounted into app routing.
- [ ] Full gates remain blocked by missing Phase 8/9 browser journeys, discipline result/game-served integration, notification email fan-out, volunteer closure recipients, the facility image serving contract, and baseline WebKit failures. Do not mark ready until browser journeys and all acceptance criteria pass.

## Cross-track requests and blockers

- **Track C (sprint wiring owner):** mount the registered schedule console/portal routes and navigation; coordinate Phase 8/9 Chromium + WebKit mobile journeys with axe; provide a safe public URL/serving contract for approved facility layout files. The public facility API currently returns a layout file ID and the page renders facility details, directions, parking and spaces, but cannot safely render the image without that contract.
- **Track A:** investigate the four baseline Playwright failures in sign-in, ownership transfer and the people flow before the full browser gate.
- **Track B:** align shared `contestStageSchema` with `02-DATA-MODEL.md`: it accepts `tournament` (rejected by `contests_stage_check`) and omits `championship`/`consolation`/`exhibition`; G's service/routes now follow the data-model enum. Generator fairness and double-elimination bye progression fixes are in G's current branch and need review with the shared-algorithm owner before integration.
- **Track H:** expose volunteer assignments by event so emergency closure notifications can reach affected volunteers. No volunteer assignment module or table is present on current trunk.
- **Track F / discipline service owner:** expose the transaction-scoped result-to-discipline creation and finalized-game-served operation needed for automatic card/ejection suspensions. The current service provides `assertNotSuspendedForLineup`, which G calls, but does not provide `createFromContestResult` or automatic games-served counting. Result finalization therefore rejects card finalization with an explicit service-unavailable conflict instead of silently skipping discipline enforcement.
- **Track B / C notifications integration:** connect emergency closure notification events to the notification fan-out contract. G batches changes and emits through Track B's notification service; that service currently marks only `in_app`, so the required Mailpit email journey is not yet evidenced. G must not implement a separate messaging pipeline.

## Decisions and review

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, Phase 8/9 in `11`, `02 §H/I/J/Q`, and `05 §6`.
- G decisions are `DEC-082–105` in `docs/codex/DECISIONS.md`; the latest trunk decisions are preserved through `DEC-081`.
- Last trunk sync: `70b7c2d` (through `af353fc`); earlier syncs were `7bd217f` (through `9b5b430`), `925d8ff` (through `d991fee`) and `69bd7c9` (through `4660724`). The latest lock-protected self-merge attempt failed before the algorithm fixes and was rolled back. All G changes remain local on `track/g-schedule`; nothing was pushed.
- Do not mark ready or write “Track G complete” until the outstanding cross-track contracts, schedule journeys and full gates pass.
