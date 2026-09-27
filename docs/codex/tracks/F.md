# Track F — safety

Status: in-progress (Phase 6)
Branch: `track/f-safety`
Current: Phase 7 (migrations 2000–2008: compliance, safety, discipline + UI) is implemented on top of `rebuild/trunk` at `77f58d8` and passed a full gate earlier (see "Phase 7 gate" below). Phase 6 work on this branch includes calendar-backed sessions, confirmed tryout registration checks, evaluator assignment and scoring, shared normalization and balancing, family-scoped placement preferences, offer lifecycle jobs, and Rec team roster publishing.
Ready for integration: not yet — offer checkout, generated-route discovery, real offline Playwright coverage, and the Phase 6 merge gate remain open.
Requests to other tracks: C — discover `web/src/console/evaluations/routes.tsx` and `web/src/portal/evaluations/routes.tsx` in the generated feature registry; allow assigned evaluators to read only consented participant photos through audited file access. E — wire the offer checkout adapter to registration, deposit and installment checkout, including family checkout continuation.
Open dependencies: Phase 6 offer acceptance still uses an injected adapter; nested evaluation pages remain unreachable from `web/src/app.tsx` until C's router work lands. Continue service/UI work against those contracts while the dependencies are open.
Phase 7 gate (earlier): `npm run typecheck`, `npm run lint`, `npm test` (75 files passed, 1 skipped; 348 passed, 1 skipped), `npm run test:e2e` (9 passed, 3 skipped), `npm run build`, `npm run registry`, `npm run openapi` all passed at `77f58d8`; Phase 7 Playwright journeys remain an A-owned gap.
Targeted verification (Phase 7): `server/src/modules/compliance/phase7.integration.test.ts` — 5 passed against isolated PostgreSQL.
Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_f`, `PORT_OFFSET=600` (PostgreSQL on 127.0.0.1:6032, stripe-mock on 12711, mailpit on 8625/1625).
