# Track F — safety

Status: in-progress (Phase 6 only; Phase 7 implementation remains on this branch).
Branch: `track/f-safety`
Phase 6 progress: sessions, group eligibility, sequential bibs, check-in, compliance-gated evaluator assignment, concurrent/idempotent scoring, offline score queue, normalization, results, team balancing, placement locks, Rec roster publishing, offers and reminders are implemented. The Rec console exposes optional 1–5 coach-supplied ratings for confirmed players and the balancer consumes them. Rec and tryout placement boards support pointer drag/drop with keyboard move controls. Staff with photo-management permissions can capture and attach an athlete photo only when current media consent is granted; scoring reads the current profile photo and suppresses it when consent is revoked.
Ready for integration: not yet — offer checkout, assigned-evaluator photo access, offer acceptance Playwright coverage, and the merge gate remain open.
Requests to other tracks: C — allow assigned evaluators to read only currently consented participant photos through audited file access. E — wire the offer checkout adapter to registration, deposit and installment checkout, including family checkout continuation.
Open dependencies: offer acceptance still uses an injected adapter. The evaluator photo renderer uses the consent-gated scoring-sheet API, but sensitive file downloads remain restricted until C wires audited assigned-evaluator access. The latest trunk merge added evaluation routes to the generated router; this branch now exports the names that registry generation expects. Continue service/UI work against those contracts while the dependencies are open.
Targeted verification (2026-09-27): evaluation portal/console/photo web tests — 5 passed; `server/src/modules/evaluations/phase6.integration.test.ts` — 10 passed against isolated PostgreSQL; `e2e/evaluations.spec.ts` — 4 passed across Chromium desktop and WebKit mobile with axe; `npm run typecheck`, `npm run lint`, `npm run build`, changed-file ESLint, `npm run registry`, and `npm run openapi` passed. The Phase 6 full merge gate and live offer checkout E2E remain outstanding.
Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_f`, `PORT_OFFSET=600` (PostgreSQL on 127.0.0.1:6032, stripe-mock on 12711, mailpit on 8625/1625).

## HANDOFF

Done: Phase 6 implementation is committed through `18efdc7` on `track/f-safety`: evaluation and tryout sessions, groups and bibs, check-in, eligibility-gated evaluator assignment, concurrent/idempotent and offline scoring, normalization, results, team balancing, placement locks, Rec roster publishing, offer/reminder flows, optional coach ratings, placement drag/drop, and consent-gated photo capture/display. Targeted verification passed: five web tests, ten Phase 6 PostgreSQL integration tests, and four Playwright cases across Chromium desktop and WebKit mobile with axe; typecheck, lint, build, registry generation, OpenAPI generation, and changed-file ESLint passed.

In progress (exact paths): offer checkout integration and acceptance coverage in `server/src/modules/evaluations/service.ts`, `server/src/modules/evaluations/routes.ts`, `web/src/console/evaluations/EvaluationsConsole.tsx`, `web/src/portal/evaluations/EvaluationPortal.tsx`, and `e2e/evaluations.spec.ts`; audited assigned-evaluator photo reads through the Files contract, rendered from `server/src/modules/evaluations/service.ts` and `web/src/console/evaluations/EvaluationsConsole.tsx`. Related owned implementation and tests are in `server/src/modules/evaluations/{jobs.ts,module.ts,phase6.integration.test.ts,schemas.ts}`, `web/src/console/evaluations/{EvaluationsConsole.test.tsx,evaluation-photo.test.ts,evaluation-photo.ts,evaluations.css,nav.ts,routes.tsx}`, `web/src/portal/evaluations/{EvaluationPortal.test.tsx,evaluations.css,nav.ts,routes.tsx}`, `web/src/generated/nested-routes.ts`, and `e2e/evaluations.spec.ts`.

Next steps, in order:
1. Merge current `rebuild/trunk` (`2ac58d6`) into `track/f-safety` before further edits and regenerate the nested route registry.
2. Check for E's checkout contract on trunk, then connect offer acceptance to registration, deposits/installments, and family checkout continuation.
3. Check for C's audited Files permission for assigned evaluators; complete consent/revocation-safe participant photo access using that contract.
4. Add end-to-end offer acceptance coverage, then run the targeted evaluation integration, web, and Chromium/WebKit journeys.
5. Run the full sprint merge gate through `/Users/sammooney/athlentry-sprint/heavy.sh`; if it passes, self-merge `track/f-safety` to `rebuild/trunk` with the documented protocol. Phase 12 is assigned to Track I per the sprint plan.

Known failing tests: none among the targeted checks above. The full merge gate has not been run, so full-suite status is unknown. The branch is not ready for integration; no self-merge was made because the required merge gate is still outstanding.

Open requests: Track E — offer checkout wired to registration, deposit/installment checkout, and family continuation. Track C — audited Files access for assigned evaluators, limited to currently consented participant photos. No owner request is open.

Working branch: `track/f-safety`, currently based on `rebuild/trunk` through `27c2826`; trunk has advanced to `2ac58d6`. Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_f`, `PORT_OFFSET=600`.
HANDED OFF 12:17
