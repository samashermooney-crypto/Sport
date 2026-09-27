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
- [x] Schedule mutations now include the required same-origin request marker, and the season-end award list qualifies tenant columns after joining people and teams.
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
- [x] `npm run typecheck` and `npm run lint` pass after syncing `rebuild/trunk` through `af353fc` (merge `70b7c2d`).
- [x] Updated scheduling access integration passes, including official closure recipients and emergency batch timing.
- [x] Program statistic settings, leaderboard aggregation, enabled/public filters, private-stat staff access, and optimistic-concurrency integration regression pass against the isolated Postgres stack.
- [x] Season-award listing query regression passes against isolated Postgres after qualifying joined table columns.
- [x] Statistics configuration, contest creation, finalized score with persisted per-team stats, facility closure preview and postponement, public leaderboard, and public standings snapshot Playwright journey passes on Chromium desktop and WebKit mobile with axe and no schedule-page alerts.
- [x] Latest standings table follow-up adds a keyboard-focusable named scroll region; focused schedule-stats journey passes Chromium desktop and WebKit mobile, and targeted ESLint plus `npm run typecheck` pass.
- [x] Family guardian RSVP browser journey passes on Chromium desktop and WebKit mobile with axe; it caught and fixed the portal's missing same-origin request marker.
- [x] Offline coach game-day journey passes on Chromium desktop and WebKit mobile with axe: attendance and score queue offline, attendance syncs after reconnect, and the newer server score is preserved while the score conflict remains visible.
- [x] Chromium + WebKit mobile baseline E2E: 38 passed, 4 failed, 4 skipped; failures were unrelated sign-in, ownership-transfer and people journeys, and no G schedule journey ran.
- [x] Lock-protected merge gate against `rebuild/trunk` through `2ac58d6`: typecheck and full lint passed; `heavy.sh npm test` passed 803 tests (1 skipped); full Chromium desktop Playwright passed 28 tests (4 skipped).
- [x] Lock-protected merge gate on 2026-09-27 after syncing OPS trunk through `f091afc`: typecheck and full lint passed; `heavy.sh npm test` passed 819 tests (1 skipped); full Chromium desktop Playwright passed 30 tests (4 skipped).
- [ ] Latest full-suite attempt after the standings follow-up: 818 passed, 1 skipped, and `server/src/modules/officials/service.integration.test.ts` timed out at 5 seconds; its focused retry passed (1/1). The merge gate did not pass, so the standings follow-up remains unmerged.
- [ ] Most Phase 8/9 schedule journeys remain outstanding; three G-owned browser journeys currently cover statistics/results/facility closure, family RSVP, and offline game-day sync on Chromium and WebKit mobile. The console and portal routes mount via the generated nested-route registry.
- [ ] Full gates remain blocked by missing Phase 8/9 browser journeys, discipline result/game-served integration, notification email fan-out, volunteer closure recipients, the facility image serving contract, and baseline WebKit failures. Do not mark ready until browser journeys and all acceptance criteria pass.

## Cross-track requests and blockers

- **Track C (sprint wiring owner):** include the nested schedule routes in console/portal navigation and coordinate the remaining Phase 8/9 Chromium + WebKit mobile journeys with axe. The public facility API currently returns a layout file ID and the page renders facility details, directions, parking and spaces, but cannot safely render the image without a public serving contract for approved facility layout files.
- **Track A:** investigate the four baseline Playwright failures in sign-in, ownership transfer and the people flow before the full browser gate.
- **Track B:** align shared `contestStageSchema` with `02-DATA-MODEL.md`: it accepts `tournament` (rejected by `contests_stage_check`) and omits `championship`/`consolation`/`exhibition`; G's service/routes now follow the data-model enum. Generator fairness and double-elimination bye progression fixes are in G's current branch and need review with the shared-algorithm owner before integration.
- **Track H:** expose volunteer assignments by event so emergency closure notifications can reach affected volunteers. No volunteer assignment module or table is present on current trunk.
- **Track F / discipline service owner:** expose the transaction-scoped result-to-discipline creation and finalized-game-served operation needed for automatic card/ejection suspensions. The current service provides `assertNotSuspendedForLineup`, which G calls, but does not provide `createFromContestResult` or automatic games-served counting. Result finalization therefore rejects card finalization with an explicit service-unavailable conflict instead of silently skipping discipline enforcement.
- **Track B / C notifications integration:** connect emergency closure notification events to the notification fan-out contract. G batches changes and emits through Track B's notification service; that service currently marks only `in_app`, so the required Mailpit email journey is not yet evidenced. G must not implement a separate messaging pipeline.

## Decisions and review

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, Phase 8/9 in `11`, `02 §H/I/J/Q`, and `05 §6`.
- G decisions are `DEC-082–096` and `DEC-100–108` in `docs/codex/DECISIONS.md`; Track A decisions `DEC-097–099` remain intact.
- Latest integration: G passed the lock-protected merge gate and was merged into `rebuild/trunk` on 2026-09-27; local only, not pushed.
- Do not mark ready or write “Track G complete” until the outstanding cross-track contracts, schedule journeys and full gates pass.

## HANDOFF

**State:** Track G remains in progress. Base work through `eafd228` is integrated into local `rebuild/trunk`; follow-up commit `f22babe` is committed on `track/g-schedule` but not merged because the latest full-suite gate timed out.

**Done in the latest edit:** The standings table is a keyboard-focusable named scroll region. The stats/results/closure/leaderboard/standings journey passes focused Chromium desktop and WebKit mobile with axe; targeted ESLint and `npm run typecheck` pass. The full suite had 818 passes and 1 skip, with one unrelated officials test timing out; that test passed when run alone.

**Current paths:**

- `web/src/console/schedule/ScheduleConsole.tsx` — accessible standings scroll region, committed in `f22babe`, awaiting integration.
- `e2e/schedule-stats.spec.ts` — standings snapshot browser assertions, committed in `f22babe`, awaiting integration.
- `docs/codex/tracks/G.md` — acceptance status, gate result, and outstanding cross-track requests.

**Next steps, in order:**

1. Rerun `npm run typecheck`, `npm run lint`, `heavy.sh npm test`, and the full Chromium desktop Playwright suite on the current branch. The latest merge gate is not green yet.
2. If all merge-gate checks pass, use the lock-protected self-merge protocol to integrate `track/g-schedule` into `rebuild/trunk`; if the gate remains red, keep the follow-up unmerged and record the failing test.
3. Complete the missing Phase 8/9 acceptance journeys and cross-track wiring below; run the required Chromium and WebKit mobile journeys with axe, then the full gate before marking Track G ready.
4. Update this file with final verification and write “Track G sprint complete” only after all acceptance criteria pass on trunk; then take the next open item in `SPRINT.md`.

**Known failing checks:**

- Latest full `npm test`: `server/src/modules/officials/service.integration.test.ts` → “crews ten games, handles a decline and totals the pay batch” timed out at 5 seconds. The focused file retry passed 1/1 in 2.44 seconds.
- Existing combined Chromium + WebKit baseline: 38 passed, 4 failed, 4 skipped. Failures were sign-in, ownership transfer, and people journeys; no G schedule journey ran in that baseline.
- Latest follow-up has no successful full merge gate; the prior full Chromium gate was 30 passed and 4 skipped before `f22babe`.

**Open requests:**

- Track C: verify schedule route navigation/wiring and provide a safe public serving contract for approved facility layout images; the facility API currently returns a file ID only.
- Track A: fix the baseline sign-in, ownership-transfer, and people Playwright failures.
- Track B: align `contestStageSchema` with the data-model enum and complete notification email fan-out for G's emitted closure/change events; G must keep using the shared notification service.
- Track H: expose event volunteer assignments so emergency closure notifications can include affected volunteers.
- Track F: provide transaction-scoped result-to-discipline creation and automatic games-served handling; G currently calls the lineup suspension policy but cannot finalize card discipline without those operations.

**Isolated stack:** `COMPOSE_PROJECT_NAME=athlentry_g PORT_OFFSET=700` (Postgres host port 6132).

HANDED OFF 13:35
