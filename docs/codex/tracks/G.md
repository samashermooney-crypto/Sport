+# Track G — schedule

Implementation commits: `10dde5b`, `e26dee4`, `074b533`, `535746f`, `2bc22b6`, and `dc661ea`. Track notes: `c4454b4`, `5970856`, `6c60d66`. Branch: `track/g-schedule`, local only (not pushed). The latest `rebuild/trunk` sync is merge `841ad80`, bringing in `3f0f157`.

Status: working; integration readiness is pending because the Phase 8/9 acceptance criteria and full gate are not yet met.

## Owned work and progress

- [x] G migration range `3000–3999` currently contains migrations `3000–3016`; on the isolated `athlentry_g` stack these and dependency migrations `0605`/`0606` are applied. Tenant-scoped services use `withOrg`.
- [x] Phase 8 G-owned services/UI: facilities and spaces, recurring series edits, conflict rules and overrides, allocations, generator jobs/reports, manual shift/swap, CSV import/export, publish/closure/reschedule operations, ICS, resource calendar drag/drop and keyboard moves, and facility pages.
- [x] Phase 9 G-owned services/UI: attendance/RSVP, offline coach game-day screen, results and stat workflows, standings snapshots/visibility, timed meet assignments, pools/brackets/tournament scheduling, officials assignment/pay, and season-end operations.
- [x] This turn added browser print/PDF output for schedules, results, standings and tournament brackets; safer CSV quoting/formula escaping and location round-trip; named standings rows plus visibility/config in staff UI; team-stat aggregation and public athlete personal-best views; and persistence/visibility regression tests.
- [x] Lineup suspension checks now call Track F's discipline policy. The save transaction commits the policy's audit event before returning the 409 conflict; an integration test covers both the denial and durable audit record.
- [x] `npm run registry` regenerated 18 server modules, 6 integrations and 6 web features; `npm run openapi` regenerated API documentation, including the personal-best endpoint.

## Verification

- [x] `npm run typecheck` passed after current G-owned code changes.
- [x] `npm run lint` passed after current G-owned code changes.
- [x] Production `npm run build` passed after the final attendance audit-boundary edit.
- [x] Current focused database regressions pass: attendance suspension/audit, contest personal bests and standings snapshots: 3 files / 3 tests. Earlier focused scheduling, generator, access and competition database suites also passed.
- [x] Schedule export/calendar and public standings component tests: 3 files / 8 tests passed.
- [x] `COMPOSE_PROJECT_NAME=athlentry_g PORT_OFFSET=700 npm run test:e2e`: 32 passed, 4 guarded skips. Generic desktop and WebKit mobile accessibility/design journeys ran, but no G schedule journey ran because Track A has not composed these routes into the app.
- [ ] Latest full `npm test`: 659 passed, 1 skipped, 1 failed. The only failure is Track B's shared 48-team generator home/away balance assertion; this run took 52.4 seconds. A preceding run exceeded the 60-second budget at 80.5 seconds. Rerun after Track B fixes fairness and runtime; do not alter or weaken its test in G.
- [ ] Phase 8/9 Chromium + WebKit mobile schedule journeys with axe remain outstanding with Track A. Current E2E results do not verify G schedule workflows.
- [ ] Full gate remains blocked by the failed generator test and missing schedule E2E journeys; rerun all five phase gates before marking ready.

## Cross-track requests and blockers

- **Track A:** compose the registered schedule console/portal routes and navigation; add Phase 8/9 Chromium + WebKit mobile journeys with axe; provide a safe public URL/serving contract for approved facility layout files. The public facility API currently returns a layout file ID and the page renders facility details, directions, parking and spaces, but cannot safely render the image without that contract.
- **Track B:** repair home/away fairness for truncated double-round-robin pairings (the 8-game/8-team test previously exposed 1/7 splits) and make the seeded 48-team generator deterministically finish within 60 seconds. The latest full run failed the H/A difference assertion in 52.4 seconds; a preceding run exceeded 60 seconds at 80.5 seconds.
- **Track F:** expose the transaction-scoped result-to-discipline creation and finalized-game-served operation needed for automatic card/ejection suspensions. The discipline service on trunk provides `assertNotSuspendedForLineup`, which G now calls, but does not provide `createFromContestResult` or automatic games-served counting. Result finalization therefore reports the missing integration as unavailable instead of silently skipping discipline enforcement.

## Decisions and review

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, Phase 8/9 in `11`, `02 §H/I/J/Q`, and `05 §6`.
- G decisions are `DEC-062–078` in `docs/codex/DECISIONS.md`; `DEC-057–061` belong to Track F after the trunk merge.
- Last trunk merge: `841ad80` (`rebuild/trunk` at `3f0f157`). All changes remain local on `track/g-schedule`; nothing was pushed.
- Do not mark ready or write “Track G complete” until the outstanding cross-track contracts, schedule journeys, generator acceptance and full gates pass.
