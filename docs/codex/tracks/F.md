# Track F — safety

Status: in-progress (Phase 6)
Branch: `track/f-safety`
Current: Phase 7 (migrations 2000–2008: compliance, safety, discipline + UI) is implemented on top of `rebuild/trunk` at `77f58d8` and passed a full gate earlier (see "Phase 7 gate" below). Phase 6 is active: reviewed the Devin WIP, added migration 2505 for calendar-backed evaluation sessions, confirmed tryout-registration checks, placement group mapping, family-scoped rec preferences, scorer notes/offline queue handling, consistency dashboard and coverage tests.
Ready for integration: nothing new yet — Phase 6 WIP lands after service tests and the merge gate pass.
Requests to other tracks: C — wire `web/src/console/evaluations/routes.tsx` and `web/src/portal/evaluations/routes.tsx` into the generated feature registry; the nested evaluation routes are currently unreachable from `web/src/app.tsx`, so the Phase 6 Chromium/WebKit Playwright journey cannot run against the app until registry discovery is updated. E — provide and wire the offer checkout adapter contract to the registration/invoice/deposit/installment service, including a family checkout continuation result; this branch currently tests `acceptTeamOffer()` with a fake adapter only. A — Phase 7 Chromium and WebKit mobile journeys with axe remain outstanding (2026-09-27); C — authorize linked guardian restricted uploads and owner/compliance restricted evidence downloads through files (2026-09-27); C/B — run `credentials.expiry` from the job registry and provide notification delivery (2026-09-27); H — consume `server/src/modules/safety/safesport.ts` for message and conversation checks (2026-09-27).
Requests to I: commit `a929006` (WIP, since removed from this branch) contains a Phase 12 draft worth mining — `db/migrations/5000_phase12_classes.sql` (class_offerings/sessions/instructors/enrollments/tuition_subscriptions/attendance/makeup_credits+bookings/skill_definitions+records/level_recommendations) + `5001_phase12_tuition_progression.sql` (session credits, credit redemptions) and `server/src/modules/classes/{module,routes,schemas,service}.ts` (~490-line service with enrollment capacity checks, makeup credit ledger, skill evaluations). It compiles but has no tests and was never reviewed; treat as reference only.
Blocked on: Phase 6 offer acceptance needs E's checkout adapter contract (offer → registration + deposit + installments); `acceptTeamOffer` is coded against an injected `OfferCheckoutAdapter` interface in `server/src/modules/evaluations/service.ts`.
Phase 7 gate (earlier): `npm run typecheck`, `npm run lint`, `npm test` (75 files passed, 1 skipped; 348 passed, 1 skipped), `npm run test:e2e` (9 passed, 3 skipped), `npm run build`, `npm run registry`, `npm run openapi` all passed at `77f58d8`; Phase 7 Playwright journeys remain an A-owned gap.
Targeted verification (Phase 7): `server/src/modules/compliance/phase7.integration.test.ts` — 5 passed against isolated PostgreSQL.
Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_f`, `PORT_OFFSET=600` (PostgreSQL on 127.0.0.1:6032, stripe-mock on 12711, mailpit on 8625/1625).

## HANDOFF

Checkpoint: `0fef2bb` (`feat(evaluations): checkpoint phase 6 handoff work`) on `track/f-safety`; working tree was clean at handoff. `ad91d2f` merged `rebuild/trunk` into this branch before the checkpoint. No trunk merge was attempted: Phase 6 has not passed the sprint merge gate, and trunk repair by Track C is still in progress.

Done: Phase 7 implementation (migrations 2000–2008) previously passed the full gate recorded above. Phase 6 WIP now includes migration 2505 and generated DB types; confirmed-registration tryout/check-in validation, evaluator assignment and consistency, group-to-division placement mapping, family-scoped placement preferences, offers behind an injected checkout adapter, Rec league placement, CSV/API artifacts, and offline scorer queue coverage. The offline portal unit test, shared evaluation/team-balancer tests, targeted Phase 6 PostgreSQL integration suite (10/10), typecheck, targeted ESLint, `npm run registry`, and `npm run openapi` passed before checkpoint. The commit hook ran typecheck during checkpoint creation. This is a checkpoint, not a ready-for-integration claim.

In progress — implementation in `0fef2bb` (review these exact paths):

- `db/migrations/2505_phase6_calendar_events.sql`
- `server/src/db/types.ts`
- `server/src/modules/evaluations/module.ts`
- `server/src/modules/evaluations/phase6.integration.test.ts`
- `server/src/modules/evaluations/routes.ts`
- `server/src/modules/evaluations/schemas.ts`
- `server/src/modules/evaluations/service.ts`
- `shared/src/generated/errors.ts`
- `docs/api/openapi.json`
- `docs/codex/DECISIONS.md`
- `web/src/console/evaluations/EvaluationsConsole.tsx`
- `web/src/console/evaluations/evaluations.css`
- `web/src/portal/evaluations/EvaluationPortal.test.tsx`
- `web/src/portal/evaluations/EvaluationPortal.tsx`
- `web/src/portal/evaluations/evaluations.css`
- `web/src/portal/evaluations/nav.ts`
- `web/src/portal/evaluations/routes.tsx`

Next steps, in order:

1. Review `0fef2bb` and the inherited Devin WIP commit `ce40d4f`; rerun focused lint, typecheck, and the isolated Phase 6 DB suite after any edits. The 2505 migration is already applied in the local test DB; do not edit its checksum in place.
2. Ask Track C through the documented coordination channel to make the nested console and portal evaluation routes discoverable from `web/src/app.tsx`; current generated web registry omits those nested routes. Ask Track E for the production offer checkout adapter integration and family checkout continuation.
3. Add Phase 6 Playwright coverage for event creation/check-in, evaluator scoring/offline sync, placement and offer flows; run Chromium and WebKit mobile with axe after the routes are reachable. Add the offer/deposit journey after E's checkout integration is available.
4. Run the sprint Phase 6 full merge gate using `~/athlentry-sprint/heavy.sh`; repair failures without weakening tests. Only then perform the locked self-merge to `rebuild/trunk` if trunk is green.
5. After Phase 6 integration, merge/review `track/i-academy` as required by `SPRINT.md`, finish Phase 12 academy/class mode, run its focused and full gates, then self-merge with the sprint protocol.

Known failing/unrun verification: the attempted `e2e/evaluation-offline.spec.ts` journey failed in both Chromium and WebKit because the nested evaluation page was absent from the generated route registry; that temporary spec was removed, so it must be re-added after C's routing change. Full lint, full test suite, full Playwright suite, and build have not been run on this checkpoint. No Phase 6 ready-for-integration gate has passed.

Open requests: C — nested evaluation route registry discovery; E — offer checkout adapter wired to registration/invoice/deposit/installments and family continuation. Existing Phase 7 follow-ups remain: A — Phase 7 Chromium/WebKit mobile journeys with axe; C — linked-guardian restricted uploads and owner/compliance restricted evidence downloads; C/B — register `credentials.expiry` and provide notification delivery; H — consume `server/src/modules/safety/safesport.ts` for message/conversation checks. Phase 12 is not started here; Track I's removed draft commit `a929006` is reference-only until inspected.

Environment: `COMPOSE_PROJECT_NAME=athlentry_f PORT_OFFSET=600` (PostgreSQL `127.0.0.1:6032`, stripe-mock `12711`, mailpit `8625/1625`).
HANDED OFF 10:47
