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
- [x] Lineup suspension checks now call Track F's discipline policy. The save transaction commits the policy's audit event before returning the 409 conflict; an integration test covers both the denial and durable audit record.
- [x] `npm run registry` regenerated 18 server modules, 6 integrations and 6 web features; `npm run openapi` regenerated API documentation, including the personal-best endpoint.

## Verification

- [x] `npm run typecheck` and `npm run lint` passed after syncing trunk through `4660724`; post-edit typecheck and targeted ESLint also pass.
- [x] Production `npm run build` passed after the final attendance audit-boundary edit.
- [x] Current focused database regressions pass: attendance suspension/audit, contest personal bests and standings snapshots: 3 files / 3 tests. Earlier focused scheduling, generator, access and competition database suites also passed.
- [x] Schedule export/calendar and public standings component tests: 3 files / 8 tests passed.
- [x] Focused suite on the `d991fee` sync: 12 files / 25 tests passed; the 48-team generator acceptance test failed its per-team home/away difference assertion after 50.6 seconds. The updated access integration test passes on `4660724`.
- [x] Earlier generic `test:e2e`: 32 passed, 4 guarded skips; it did not cover G schedule workflows.
- [ ] Latest full `npm test`: 659 passed, 1 skipped, 1 failed. The only failure is Track B's shared 48-team generator home/away balance assertion; this run took 52.4 seconds. A preceding run exceeded the 60-second budget at 80.5 seconds. Rerun after Track B fixes fairness and runtime; do not alter or weaken its test in G.
- [ ] Phase 8/9 Chromium + WebKit mobile schedule journeys with axe remain outstanding. No G journeys currently exist and the registered schedule routes are not mounted into app routing.
- [ ] Full gates remain blocked by generator fairness, missing Phase 8/9 browser journeys, and the discipline result/game-served contract. Do not mark ready until G journeys and all acceptance criteria pass.

## Cross-track requests and blockers

- **Track C (sprint wiring owner):** mount the registered schedule console/portal routes and navigation; coordinate Phase 8/9 Chromium + WebKit mobile journeys with axe; provide a safe public URL/serving contract for approved facility layout files. The public facility API currently returns a layout file ID and the page renders facility details, directions, parking and spaces, but cannot safely render the image without that contract.
- **Track B:** repair home/away fairness for truncated double-round-robin pairings (the 8-game/8-team test previously exposed 1/7 splits) and make the seeded 48-team generator deterministically finish within 60 seconds. The latest full run failed the H/A difference assertion in 52.4 seconds; a preceding run exceeded 60 seconds at 80.5 seconds.
- **Track H:** expose volunteer assignments by event so emergency closure notifications can reach affected volunteers. No volunteer assignment module or table is present on current trunk.
- **Track F / discipline service owner:** expose the transaction-scoped result-to-discipline creation and finalized-game-served operation needed for automatic card/ejection suspensions. The current service provides `assertNotSuspendedForLineup`, which G calls, but does not provide `createFromContestResult` or automatic games-served counting. Result finalization therefore rejects card finalization with an explicit service-unavailable conflict instead of silently skipping discipline enforcement.
- **Track B / C notifications integration:** connect emergency closure notification events to the notification fan-out contract. G batches changes and emits through Track B's notification service; that service currently marks only `in_app`, so the required Mailpit email journey is not yet evidenced. G must not implement a separate messaging pipeline.

## Decisions and review

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, Phase 8/9 in `11`, `02 §H/I/J/Q`, and `05 §6`.
- G decisions are `DEC-080–096` in `docs/codex/DECISIONS.md`; the latest trunk decisions are preserved through `DEC-079`.
- Last completed trunk syncs: `925d8ff` (through `d991fee`) and `69bd7c9` (through `4660724`). All changes remain local on `track/g-schedule`; nothing was pushed.
- Do not mark ready or write “Track G complete” until the outstanding cross-track contracts, schedule journeys, generator acceptance and full gates pass.
