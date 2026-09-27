# Track G — schedule

Implementation commits: `10dde5b` plus the current local changes on `track/g-schedule` (not pushed).
Status: working
Ready for integration: pending — Phase 8/9 acceptance and full gates are not yet met.
Requests to other tracks: A: compose schedule console/portal routes and nav, add Phase 8/9 Chromium + WebKit mobile journeys with axe, and expose approved facility layout images publicly; B: add official assignment notification types/payloads to the notification catalog and fix the 48-team generator's home/away balance while keeping its runtime below 60 seconds; D: expose resource-calendar drag/drop and keyboard move callbacks; F: integrate the discipline service contract used by result finalization.
Blocked on: Track A route composition and E2E ownership; Track B official notification types and shared generator fairness; Track D resource-calendar interaction contract; Track F discipline service.

## Progress

- [~] Merged local `rebuild/trunk` at `6ae212a` in `8d47c08`; migrations `3000–3016` are applied on the isolated stack, and database types, registry and OpenAPI were regenerated.
- [~] Phase 8 services/UI: facility/space CRUD, recurrence series, conflicts, allocations, generator jobs/reports, manual shift/swap, CSV import/export, publishing, closures, reschedules and ICS implemented; route composition and resource drag/drop remain.
- [~] Phase 9 services/UI: attendance/RSVP, result/stat/standings flows, timed-meet heat/lane assignments, pool round robin, bracket seeding, elimination brackets, tournament-mode scheduling through the shared generator, officials/pay and season end implemented. Coach game-day offline storage and conflict handling, public bracket rendering, and public facility pages exist in the Track G UI paths.
- [ ] Track A route/nav integration and schedule-specific Playwright journeys (Chromium, WebKit mobile, axe) remain. Latest isolated E2E run: 28 passed, 4 skipped; no schedule journey runs until A composes the routes.
- [ ] Full gates: `npm test` has 589 passed, 1 skipped, 1 failed; the failure is Track B's unchanged 48-team home/away-balance assertion, with 58.7s runtime under the 60s limit. Typecheck, lint, build, registry and OpenAPI pass. Focused tournament schedule PostgreSQL integration passes 1/1.
- [x] `npm run registry` and `npm run openapi` regenerated after G module registration and trunk sync.

## Self-review / decisions

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, `11 Phase 8–9`, `02 §H/I/J/Q` and `05 §6`.
- `DEC-055–062` capture recurrence migration, conflict overrides, recurrence history, blackout approvals, immutable format snapshots, survey privacy/locale and printable award output.
- `DEC-063–066` record standings-driven pool-to-bracket seeding, post-seeding correction policy, versioned timed-meet lane assignment, the public bracket response allowlist, and separate tournament schedule reservations.
- The current focused isolated tournament/meet DB run passes 2 files / 5 tests; the earlier targeted scheduling suite passed 6 files / 16 tests, schedule notification/CSV/DST tests passed 9/9, and schema spine tests passed 4/4.
- Not ready: cross-track contracts and the unimplemented Phase 8/9 items above still prevent acceptance; do not mark `Track G complete` until all criteria and gates pass.
