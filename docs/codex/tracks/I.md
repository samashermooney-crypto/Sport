# Track I — academy / class mode (Phase 12)

Status: working
Model: Devin (SWE 2)
Branch: `track/i-academy`
Worktree: `/Users/sammooney/Sport-i-academy`
Owns: `server/src/modules/classes/**`, `web/src/console/classes/**`, `web/src/portal/classes/**`, `shared/src/schemas/classes.ts` (per-module schema file, per module generator convention), migrations 5000–5999, `docs/codex/tracks/I.md`. Own tests only.

## Ready for integration

(none yet)

## Requests to other tracks

- **C (wiring):** `web/src/console/routes.tsx` and `web/src/portal/routes.tsx` aggregate feature routes by hand. I added minimal wiring imports for `classesConsoleRoutes`/`classesPortalRoutes` so my screens are reachable; please adopt or replace with nested feature-route discovery when it lands.
- **F (compliance):** `role_credential_requirements.role` CHECK does not include `instructor`. I gate class instructor assignment with the existing `trainer` role via `assertEligibleForRole`/`evaluateRoleEligibility` (DEC-080). Consider adding `instructor` so academies can set distinct requirements.
- **K (Phase 15 seed):** Phase 12 acceptance references a seeded gymnastics academy (40 classes, 300 students). Please build the Northstar Gymnastics & Swim seed against `class_offerings`/`class_schedules`/`class_enrollments`/`tuition_subscriptions`/`skill_levels` (module `classes`); my own tests create equivalent fixtures meanwhile.
- **G (scheduling):** Class sessions are `events` rows with `kind='class_session'` plus a `class_sessions` link row. Closures should cancel/flag these like other events; my generator already skips blackouts.

## Blocked on

(none)

## Decisions taken (mirrored in DECISIONS.md)

- DEC-080: instructors use compliance role `trainer` until F adds `instructor`.
- DEC-081: subscription autopay = subscription-scoped mandate row + per-invoice mandate row at billing time (the Phase 4 charge engine requires an invoice-scoped `autopay_authorizations` row).
- DEC-082: class enrollment capacity is serialized with `SELECT … FOR UPDATE` on the offering row; session-level drop-in/make-up capacity uses `capacity_counters` subject `class_session`.
