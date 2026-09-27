# Track G — schedule

Status: working
Ready for integration: pending — Phase 8/9 acceptance and full gates are not yet met.
Requests to other tracks: A: compose schedule console/portal routes and nav, add Phase 8/9 Chromium + WebKit mobile journeys with axe, and expose approved facility layout images publicly; B: add official assignment notification types/payloads to the notification catalog and fix the 48-team generator's home/away balance while keeping its runtime below 60 seconds; D: expose resource-calendar drag/drop and keyboard move callbacks; F: integrate the discipline service contract used by result finalization.
Blocked on: Track A route composition and E2E ownership; Track B official notification types and shared generator fairness; Track D resource-calendar interaction contract; Track F discipline service.

## Progress

- [x] Rebased from local `rebuild/trunk` at `c09c884`, then fast-forwarded to `58ce328`; migrations `3000–3015` and database types generated.
- [~] Phase 8 services/UI: facility/space CRUD, recurrence series, conflicts, allocations, generator jobs/reports, manual shift/swap, CSV import/export, publishing, closures, reschedules and ICS implemented; route composition and resource drag/drop remain.
- [~] Phase 9 services/UI: attendance/RSVP, result/stat/standings flows, timed-meet heat/lane assignments, pool round robin and automatic pool-to-bracket seeding, elimination brackets, officials/pay and season end implemented; tournament-mode scheduling remains. Coach game-day offline storage and conflict handling, public bracket rendering, and public facility pages now exist in the Track G UI paths.
- [ ] Track A route/nav integration and schedule-specific Playwright journeys (Chromium, WebKit mobile, axe). The fresh isolated E2E run completed 25 passed, 4 skipped, 1 failed: existing WebKit mobile control-size assertions report the showcase link at 143×20 and items-per-page select at 49×19. It did not include G schedule journeys because the route composition is owned by A.
- [ ] Full gates: latest full `npm test` has 556 passed, 1 skipped, 1 failed: shared 48-team generator runtime exceeded its 60-second limit under suite load (69.6s). An isolated rerun completed in 59.97s but failed the unchanged home/away balance assertion. Typecheck, lint, build, focused competition DB tests (5/5), registry and OpenAPI generation pass. Migration `3015` fixes the foreign-key index contract; schema tests pass 4/4.
- [x] `npm run registry` and `npm run openapi` regenerated after G module registration and trunk sync.

## Self-review / decisions

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, `11 Phase 8–9`, `02 §H/I/J/Q` and `05 §6`.
- `DEC-042–049` capture recurrence migration, conflict overrides, recurrence history, blackout approvals, immutable format snapshots, survey privacy/locale and printable award output.
- `DEC-050–052` record standings-driven pool-to-bracket seeding, post-seeding correction policy, versioned timed-meet lane assignment, and the public bracket response allowlist.
- The current focused isolated tournament/meet DB run passes 2 files / 5 tests; the earlier targeted scheduling suite passed 6 files / 16 tests, schedule notification/CSV/DST tests passed 9/9, and schema spine tests passed 4/4.
- Not ready: cross-track contracts and the unimplemented Phase 8/9 items above still prevent acceptance; do not mark `Track G complete` until all criteria and gates pass.
