# Track G — schedule

Implementation commits: `10dde5b`, `e26dee4`, `074b533`, `535746f`, `2bc22b6`, and `dc661ea`. Track notes: `c4454b4`, `5970856`, `6c60d66`. Branch: `track/g-schedule`, local only (not pushed).

Local integration range: `rebuild/trunk..track/g-schedule` (not pushed).

Status: awaiting takeover; not ready for integration because Phase 8/9 acceptance evidence and the current full merge gate are incomplete.

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
- [x] Added a 13-team double-elimination acceptance regression using the shared bracket generator and finalizer; it exposes a shared algorithm bye-progression failure before the if-necessary final.
- [x] Lineup suspension checks now call Track F's discipline policy. The save transaction commits the policy's audit event before returning the 409 conflict; an integration test covers both the denial and durable audit record.
- [x] `npm run registry` regenerated 18 server modules, 6 integrations and 6 web features; `npm run openapi` regenerated API documentation, including the personal-best endpoint.

## Verification

- [x] `npm run typecheck` and `npm run lint` passed after syncing trunk through `9b5b430` (merge `7bd217f`); post-edit typecheck and targeted ESLint pass.
- [x] Production `npm run build` passed after the final attendance audit-boundary edit.
- [x] Current focused database regressions pass: officials crew/pay acceptance, timed-meet acceptance, ICS parser checks, scheduling integration (DST, closures, moved-game ICS) and access integration: 6 files / 11 tests green after the latest fixes.
- [x] Reviewed and tested WIP commit `34ceaea`: contests/standings integration suites pass (4 files / 5 tests); all 50 seeded contest formats validate and finalize. The regression verifies configured templates persist program and division snapshots, while unconfigured sports finalize without snapshots and return a 409 for standings reads. Typecheck and full lint pass.
- [x] Schedule export/calendar and public standings component tests: 3 files / 8 tests passed.
- [x] Updated scheduling access integration passes, including official closure recipients and emergency batch timing; the focused 13-team bracket regression fails because the shared algorithm does not advance bye winners through the losers bracket to GF1.
- [x] Chromium + WebKit mobile baseline E2E: 38 passed, 4 failed, 4 skipped; failures were unrelated sign-in, ownership-transfer and people journeys, and no G schedule journey ran.
- [ ] Latest lock-protected full merge gate: typecheck and lint passed; `heavy.sh npm test` reported 757 passed, 1 skipped, 2 failed. The 48-team generator completed in 58.5 seconds but failed home/away balance; the 13-team double-elimination regression still fails to advance losers-bracket byes through GF1. The merge was aborted and trunk was left at `9b5b430`.
- [ ] Phase 8/9 Chromium + WebKit mobile schedule journeys with axe remain outstanding. No G journeys currently exist and the registered schedule routes are not mounted into app routing.
- [ ] Full gates remain blocked by generator fairness, 13-team double-elimination bye progression, missing Phase 8/9 browser journeys, discipline result/game-served integration and baseline WebKit failures. Do not mark ready until G journeys and all acceptance criteria pass.

## Cross-track requests and blockers

- **Track C (sprint wiring owner):** mount the registered schedule console/portal routes and navigation; coordinate Phase 8/9 Chromium + WebKit mobile journeys with axe; provide a safe public URL/serving contract for approved facility layout files. The public facility API currently returns a layout file ID and the page renders facility details, directions, parking and spaces, but cannot safely render the image without that contract.
- **Track A:** investigate the four baseline Playwright failures in sign-in, ownership transfer and the people flow before the full browser gate.
- **Track B:** repair the 48-team generator's home/away imbalance and shared double-elimination bye progression. The 13-team G acceptance fixture cannot complete GF1 because bye winners do not advance through the losers bracket. Also align shared `contestStageSchema` with `02-DATA-MODEL.md`: it accepts `tournament` (rejected by `contests_stage_check`) and omits `championship`/`consolation`/`exhibition`; G's service/routes now follow the data-model enum.
- **Track H:** expose volunteer assignments by event so emergency closure notifications can reach affected volunteers. No volunteer assignment module or table is present on current trunk.
- **Track F / discipline service owner:** expose the transaction-scoped result-to-discipline creation and finalized-game-served operation needed for automatic card/ejection suspensions. The current service provides `assertNotSuspendedForLineup`, which G calls, but does not provide `createFromContestResult` or automatic games-served counting. Result finalization therefore rejects card finalization with an explicit service-unavailable conflict instead of silently skipping discipline enforcement.
- **Track B / C notifications integration:** connect emergency closure notification events to the notification fan-out contract. G batches changes and emits through Track B's notification service; that service currently marks only `in_app`, so the required Mailpit email journey is not yet evidenced. G must not implement a separate messaging pipeline.

## Decisions and review

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, Phase 8/9 in `11`, `02 §H/I/J/Q`, and `05 §6`.
- G decisions are `DEC-080–099` in `docs/codex/DECISIONS.md`; the latest trunk decisions are preserved through `DEC-079`.
- Last completed trunk syncs: `7bd217f` (through `9b5b430`), `925d8ff` (through `d991fee`) and `69bd7c9` (through `4660724`). The most recent lock-protected merge attempt failed the unit gate and was rolled back. All changes remain local on `track/g-schedule`; nothing was pushed.
- Do not mark ready or write “Track G complete” until the outstanding cross-track contracts, schedule journeys, generator acceptance and full gates pass.

## HANDOFF

- **Done:** G-owned Phase 8/9 services and UI are committed on local `track/g-schedule`, synced through `rebuild/trunk` `9b5b430` (merge `7bd217f`), and remain unpushed. Acceptance work in `55fe1a3` covers officials (10 games, referee plus two assistants, decline/reassign, $1,395 pay batch), a 40-athlete/six-event timed meet with ties and team scores, and parsed moved-game ICS. Fixes include active-position handling for declined officials (migration `3017`), valid `playoff` contest stages, and person-to-team attribution through active program rosters. Follow-up commits `34ceaea`, `f83d97e`, and `2331417` cover all contest templates and configured/unconfigured standings snapshot behavior. Focused services, typecheck, lint, and production build passed as recorded above.
- **In progress / blocked paths:** no source edits are currently uncommitted. The committed 48-team generator regression in `server/src/modules/scheduling/generator.test.ts` finishes in 58.5 seconds but fails home/away balance. The committed 13-team double-elimination regression in `server/src/modules/tournaments/bracket-acceptance.test.ts` cannot finalize GF1 because shared loser-bracket byes do not advance. `server/src/modules/contests/service.ts` still cannot complete card discipline automation because Track F's transaction-scoped result creation and game-served APIs are absent. Schedule browser journeys remain unavailable until Track C mounts the registered routes; G has no Phase 8/9 Playwright journeys yet.
- **Next steps, in order:**
  1. Track B fixes the 48-team home/away fairness and double-elimination bye progression in the shared algorithms; rerun `server/src/modules/scheduling/generator.test.ts`, `server/src/modules/tournaments/bracket-acceptance.test.ts`, then the unit suite.
  2. Track C mounts the schedule console and portal routes/navigation, agrees on a safe facility-layout image serving contract, and adds Phase 8/9 Chromium and WebKit mobile journeys with axe.
  3. Track B/C completes notification fan-out to the preview email path; G continues to emit through the shared notifications module.
  4. Track H exposes volunteer assignments by event; include those volunteers in emergency closure recipients.
  5. Track F exposes transaction-scoped result-to-discipline creation and finalized-game-served counting; finish automatic discipline integration in `server/src/modules/contests/service.ts`.
  6. Track A fixes the baseline WebKit failures in `e2e/ownership-transfer.spec.ts`, `e2e/people.spec.ts`, and `e2e/sign-in.spec.ts`.
  7. Rerun generator, closure, DST, ICS, tenancy/permission, and Phase 8/9 browser journeys; then pass the full tiered merge gate before integration.
- **Known failing tests:** latest lock-protected merge gate passed typecheck and lint, while `heavy.sh npm test` reported 757 passed, 1 skipped, and 2 failed: `server/src/modules/scheduling/generator.test.ts` failed `home/away difference ≤ 1` after 58.5 seconds; `server/src/modules/tournaments/bracket-acceptance.test.ts` failed because GF1 did not finalize. Latest serial Playwright: Chromium 3/3 passed; WebKit mobile failed `e2e/ownership-transfer.spec.ts:20` (acceptance-link status), `e2e/people.spec.ts:13` (Alex Rivera heading), and `e2e/sign-in.spec.ts:151` (verification-link status). The latest full browser run was 38 passed, 4 failed, 4 skipped. The merge was aborted; trunk remains at `9b5b430` with its pre-existing `server/src/db/types.ts` edit preserved.
- **Open requests:** Track B—generator fairness and bracket bye progression; Track C—schedule route mounting, schedule journeys with axe, and facility image contract; Track B/C—notification email fan-out; Track H—volunteer assignments; Track F—discipline transaction/game-served APIs; Track A—baseline browser failures.
- **Local test stack:** `COMPOSE_PROJECT_NAME=athlentry_g PORT_OFFSET=700` (Postgres host port `6132`).
- **Integration state:** `track/g-schedule` is local and unpushed. The latest self-merge gate was red and rolled back, so no integration merge was made.

HANDED OFF 10:54
