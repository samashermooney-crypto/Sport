# Track G — schedule

Implementation commits: `10dde5b`, `e26dee4`, `074b533`, and `535746f`; track notes: `c4454b4`, `5970856`, and `6c60d66` on `track/g-schedule` (local only; not pushed). Merges: `8d47c08`, `8a4898e`, and `d899039` from `rebuild/trunk`.
Status: working
Ready for integration: pending — Phase 8/9 acceptance and full gates are not yet met.
Requests to other tracks: A: compose schedule console/portal routes and nav, add Phase 8/9 Chromium + WebKit mobile journeys with axe, and expose approved facility layout images publicly; B: fix truncated double-round-robin home/away balance (the 8-game/8-team pairing currently reaches 1/7 for two teams before slotting) and make the seeded 48-team generator deterministic within 60 seconds; F: integrate the discipline service contract used by result finalization.
Blocked on: Track A route composition and E2E ownership; Track B shared generator fairness; Track F discipline service.

## Progress

- [~] Merged local `rebuild/trunk` at `cfc3e0e` in `d899039`; migrations `3000–3016`, `0605` and `0606` are applied on the isolated stack, and database types, registry and OpenAPI were regenerated.
- [~] Phase 8 services/UI: facility/space CRUD, recurrence series and reasoned conflict overrides, allocations, generator jobs/reports, manual shift/swap, resource calendar drag/drop + keyboard moves, CSV import/export, publishing, closures, reschedules and ICS implemented; route composition remains.
- [~] Phase 9 services/UI: attendance/RSVP, result/stat/standings flows, timed-meet heat/lane assignments, pool round robin, bracket seeding, elimination brackets, tournament-mode scheduling through the shared generator, officials/pay and season end implemented. Coach game-day offline storage and conflict handling, public bracket rendering, and public facility pages exist in G-owned paths.
- [ ] Track A route/nav integration and schedule-specific Playwright journeys (Chromium, WebKit mobile, axe) remain. Latest full Playwright: 30 passed, 4 guarded skips; no schedule journey runs until A composes the routes.
- [ ] Full gates: latest `npm test` has 646 passed, 1 skipped, 1 failed; the generator acceptance exceeded 60 seconds at 68.1s. Earlier runs completed in 50.4–54.3s but failed home/away balance. Track B's `circlePairings` is the source: 8 games from a truncated double round robin yields 1 home / 7 away for two teams before placement. Typecheck, lint, build, registry and OpenAPI pass; the resource calendar has 3 passing drag, keyboard, duration, timezone and override tests. Focused Phase 8/9 PostgreSQL checks pass 4 files / 10 tests, including cross-tenant and role-denial coverage plus in-app official assignment notifications.
- [x] `npm run registry` and `npm run openapi` regenerated after G module registration and trunk sync.

## Self-review / decisions

- Reviewed `50 §2–3, §6–7`, `15 C1/C10/C16`, `03`, `20 §6–7`, `11 Phase 8–9`, `02 §H/I/J/Q` and `05 §6`.
- `DEC-057–064` capture recurrence migration, conflict overrides, recurrence history, blackout approvals, immutable format snapshots, survey privacy/locale and printable award output.
- `DEC-065–069` record standings-driven pool-to-bracket seeding, post-seeding correction policy, versioned timed-meet lane assignment, the public bracket response allowlist, separate tournament schedule reservations, and schedule-owned resource-calendar moves.
- The current focused isolated tournament/meet DB run passes 2 files / 5 tests; the earlier targeted scheduling suite passed 6 files / 16 tests, schedule notification/CSV/DST tests passed 9/9, and schema spine tests passed 4/4.
- Not ready: cross-track contracts and the unimplemented Phase 8/9 items above still prevent acceptance; do not mark `Track G complete` until all criteria and gates pass.
