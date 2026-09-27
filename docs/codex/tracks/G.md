# Track G — schedule

Implementation commits: `10dde5b`, `e26dee4`, `074b533`, `535746f`, `2bc22b6`, and `dc661ea`. Track notes: `c4454b4`, `5970856`, `6c60d66`. Branch: `track/g-schedule`, local only (not pushed).

Local integration range: `rebuild/trunk..track/g-schedule` (not pushed).

Status: working; integration readiness is pending because Phase 8/9 acceptance evidence is incomplete and the current generator suite is red.

## Owned work and progress

- [x] G migration range `3000–3999` currently contains migrations `3000–3016`; on the isolated `athlentry_g` stack these and dependency migrations `0605`/`0606` are applied. Tenant-scoped services use `withOrg`.
- [x] Phase 8 G-owned services/UI: facilities and spaces, recurring series edits, conflict rules and overrides, allocations, generator jobs/reports, manual shift/swap, CSV import/export, publish/closure/reschedule operations, ICS, resource calendar drag/drop and keyboard moves, and facility pages.
- [x] Phase 9 G-owned services/UI: attendance/RSVP, offline coach game-day screen, results and stat workflows, standings snapshots/visibility, timed meet assignments, pools/brackets/tournament scheduling, officials assignment/pay, and season-end operations.
- [x] Browser print/PDF output for schedules, results, standings and tournament brackets; safer CSV quoting/formula escaping and location round-trip; named standings rows plus visibility/config in staff UI; team-stat aggregation and public athlete personal-best views; and persistence/visibility regression tests.
- [x] Closure recipient lookup includes accounts linked to active officials assigned to the closed event; access integration regression passes.
- [x] Emergency closure batches become due immediately; routine schedule-change batches retain their 15-minute window.
- [x] Added a 13-team double-elimination acceptance regression using the shared bracket generator and finalizer; it exposes a shared algorithm bye-progression failure before the if-necessary final.
- [x] Lineup suspension checks now call Track F's discipline policy. The save transaction commits the policy's audit event before returning the 409 conflict; an integration test covers both the denial and durable audit record.
- [x] `npm run registry` regenerated 18 server modules, 6 integrations and 6 web features; `npm run openapi` regenerated API documentation, including the personal-best endpoint.

## Verification

- [x] `npm run typecheck` and `npm run lint` passed after syncing trunk through `4660724`; post-edit typecheck and targeted ESLint pass.
- [x] Production `npm run build` passed after the final attendance audit-boundary edit.
- [x] Current focused database regressions pass: attendance suspension/audit, contest personal bests and standings snapshots: 3 files / 3 tests. Earlier focused scheduling, generator, access and competition database suites also passed.
- [x] Schedule export/calendar and public standings component tests: 3 files / 8 tests passed.
- [x] Updated scheduling access integration passes, including official closure recipients and emergency batch timing; the focused 13-team bracket regression fails because the shared algorithm does not advance bye winners through the losers bracket to GF1.
- [x] Chromium + WebKit mobile baseline E2E: 38 passed, 4 failed, 4 skipped; failures were unrelated sign-in, ownership-transfer and people journeys, and no G schedule journey ran.
- [ ] Latest full `npm test` before adding the bracket regression: 752 passed, 1 skipped, 1 failed; the 48-team generator exceeded its 60-second acceptance limit at 82.1 seconds. The lock-protected trunk merge gate also failed the same test at 101.9 seconds, and the unpushed merge was rolled back to `c10e989`; the new focused 13-team bracket regression also fails on the shared algorithm.
- [ ] Phase 8/9 Chromium + WebKit mobile schedule journeys with axe remain outstanding. No G journeys currently exist and the registered schedule routes are not mounted into app routing.
- [ ] Full gates remain blocked by generator fairness, 13-team double-elimination bye progression, missing Phase 8/9 browser journeys, discipline result/game-served integration and the four baseline E2E failures. Do not mark ready until G journeys and all acceptance criteria pass.

## Cross-track requests and blockers

- **Track C (sprint wiring owner):** mount the registered schedule console/portal routes and navigation; coordinate Phase 8/9 Chromium + WebKit mobile journeys with axe; provide a safe public URL/serving contract for approved facility layout files. The public facility API currently returns a layout file ID and the page renders facility details, directions, parking and spaces, but cannot safely render the image without that contract.
- **Track A:** investigate the four baseline Playwright failures in sign-in, ownership transfer and the people flow before the full browser gate.
- **Track B:** repair the 48-team generator's runtime/home-away imbalance and shared double-elimination bye progression. The 13-team G acceptance fixture cannot complete the losers bracket, leaving the GF1 losers champion empty.
- **Track H:** expose volunteer assignments by event so emergency closure notifications can reach affected volunteers. No volunteer assignment module or table is present on current trunk.
- **Track F / discipline service owner:** expose the transaction-scoped result-to-discipline creation and finalized-game-served operation needed for automatic card/ejection suspensions. The current service provides `assertNotSuspendedForLineup`, which G calls, but does not provide `createFromContestResult` or automatic games-served counting. Result finalization therefore rejects card finalization with an explicit service-unavailable conflict instead of silently skipping discipline enforcement.
- **Track B / C notifications integration:** connect emergency closure notification events to the notification fan-out contract. G batches changes and emits through Track B's notification service; that service currently marks only `in_app`, so the required Mailpit email journey is not yet evidenced. G must not implement a separate messaging pipeline.

## Decisions and review

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, Phase 8/9 in `11`, `02 §H/I/J/Q`, and `05 §6`.
- G decisions are `DEC-080–096` in `docs/codex/DECISIONS.md`; the latest trunk decisions are preserved through `DEC-079`.
- Last completed trunk syncs: `925d8ff` (through `d991fee`) and `69bd7c9` (through `4660724`). The most recent lock-protected merge attempt failed the unit gate and was rolled back. All changes remain local on `track/g-schedule`; nothing was pushed.
- Do not mark ready or write “Track G complete” until the outstanding cross-track contracts, schedule journeys, generator acceptance and full gates pass.

## HANDOFF

- **Done:** G-owned Phase 8/9 service and UI implementation is committed on local `track/g-schedule`; the branch includes trunk through `4660724`. Recent closure work includes assigned-official recipients and immediate emergency batches. The focused Chromium sign-in, ownership-transfer and people journeys all pass.
- **In progress / blocked paths:** `server/src/modules/tournaments/bracket-acceptance.test.ts` is a committed 13-team double-elimination regression that cannot complete GF1 because Track B's shared algorithm does not advance losers-bracket bye winners. `server/src/modules/scheduling/generator.test.ts`'s 48-team case exceeds its 60-second limit (82.1s in the latest full unit run). There are no uncommitted implementation edits. G's actual schedule Playwright journeys are not present because the registered routes are not mounted.
- **Next steps, in order:**
  1. Ask Track B to repair the shared 48-team generator runtime/fairness and loser-bracket bye progression; rerun the two targeted generator/bracket regressions and unit gate.
  2. Ask Track C to mount the registered schedule console and portal routes/navigation, define the safe facility-layout image serving contract, and add Phase 8/9 Chromium and WebKit mobile journeys with axe.
  3. Coordinate Track B/C notification fan-out so closure notifications reach the required preview email path; preserve G's use of the shared notification module.
  4. Coordinate with Track H on volunteer-by-event assignments and include volunteers in emergency closure recipients.
  5. Coordinate with Track F on transaction-scoped result-to-discipline creation and finalized-game-served counting; then complete automatic discipline integration in result finalization.
  6. Have Track A resolve the remaining baseline WebKit failures in ownership transfer, people and sign-in.
  7. Rerun generator, closure, DST, ICS, tenancy/permission and Phase 8/9 browser tests; run the complete tiered gate. The last lock-protected self-merge gate was red and rolled back, so do not merge until the gate passes.
- **Known failing tests:** latest serial Playwright rerun: Chromium 3/3 passed; WebKit mobile failed `e2e/ownership-transfer.spec.ts:20` (acceptance link status), `e2e/people.spec.ts:13` (Alex Rivera heading), and `e2e/sign-in.spec.ts:151` (verification-link status). Latest full `npm test` before the new bracket regression: 752 passed, 1 skipped, 1 failed (48-team generator took 82.1s); the focused `server/src/modules/tournaments/bracket-acceptance.test.ts` regression fails at loser-bracket bye progression. The latest full browser run was 38 passed, 4 failed, 4 skipped.
- **Open requests:** Track B: generator and bracket fixes; Track C: route mounting, schedule journeys/axe and facility image contract; Track B/C: notification email fan-out; Track H: volunteer assignments; Track F: discipline transaction/game-served APIs; Track A: baseline browser failures.
- **Local test stack:** `COMPOSE_PROJECT_NAME=athlentry_g PORT_OFFSET=700`.
- **Integration state:** `track/g-schedule` is local and unpushed. The trunk merge attempt failed the full unit gate and was rolled back; skip self-merge while the gate remains red.
