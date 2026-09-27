# Track F — safety

Status: in-progress (Phase 6 only; Phase 7 implementation remains on this branch).
Branch: `track/f-safety`
Phase 6 progress: sessions, group eligibility, sequential bibs, check-in, compliance-gated evaluator assignment, concurrent/idempotent scoring, offline score queue, normalization, results, team balancing, placement locks, Rec roster publishing, offers and reminders are implemented. The Rec console exposes optional 1–5 coach-supplied ratings for confirmed players and the balancer consumes them. Rec and tryout placement boards support pointer drag/drop with keyboard move controls. Staff with photo-management permissions can capture and attach an athlete photo only when current media consent is granted; scoring reads the current profile photo and suppresses it when consent is revoked.
Ready for integration: not yet — live offer checkout, assigned-evaluator photo access, and the merge gate remain open. Family offer acceptance now continues to E's checkout requirements route, covered by Playwright; the live registration checkout adapter is still absent.
Requests to other tracks: C — wire the evaluation router's offer checkout adapter and allow assigned evaluators to read only currently consented participant photos through audited file access. E — implement the offer checkout adapter against registration, deposit and installment checkout, including family checkout continuation.
Open dependencies: offer acceptance still uses an injected adapter. The evaluator photo renderer uses the consent-gated scoring-sheet API, but sensitive file downloads remain restricted until C wires audited assigned-evaluator access. The latest trunk merge added evaluation routes to the generated router; this branch now exports the names that registry generation expects. Continue service/UI work against those contracts while the dependencies are open.
Targeted verification (2026-09-27): `server/src/modules/evaluations/phase6.integration.test.ts` — 10 passed against isolated PostgreSQL; portal/console/photo web tests — 6 passed; `e2e/evaluations.spec.ts` — 6 passed across Chromium desktop and WebKit mobile with axe. The commit hook passed changed-file ESLint and `npm run typecheck`; earlier verification also passed `npm run lint`, `npm run build`, `npm run registry`, and `npm run openapi`. The Phase 6 full merge gate and live offer checkout E2E remain outstanding.
Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_f`, `PORT_OFFSET=600` (PostgreSQL on 127.0.0.1:6032, stripe-mock on 12711, mailpit on 8625/1625).

## HANDOFF

Done:
- Merged `rebuild/trunk` at `5ae5499` into this branch in `7e6c8ab`.
- Committed the current accepted-offer continuation and evaluator privacy/compliance coverage as `86d5336` (`feat(evaluations): continue accepted offers to checkout`). The offer UI routes an accepted family offer to E's checkout requirements path; evaluator assignment is credential-gated, and scoring-sheet tests cover PII suppression and tenant/assignment access.
- Targeted checks listed above pass. No full merge gate was run, so this work is not ready for trunk integration.

In progress (exact paths):
- `web/src/portal/evaluations/EvaluationPortal.tsx` — accepted offers navigate to the registration checkout requirements route after the injected adapter returns a checkout ID.
- `web/src/portal/evaluations/EvaluationPortal.test.tsx` — verifies that continuation behavior.
- `e2e/evaluations.spec.ts` — verifies the family offer continuation route on Chromium desktop and WebKit mobile with axe.
- `server/src/modules/evaluations/phase6.integration.test.ts` — credential-gated evaluator assignment and scoring-sheet privacy coverage.
- Phase 6 remains incomplete until the open checkout and Files dependencies below are closed and the full merge gate passes.

Next steps, in order:
1. Merge the latest `rebuild/trunk` into `track/f-safety` and resolve generated files only by running the prescribed generation commands.
2. Coordinate with E to implement `OfferCheckoutAdapter` using registration checkout, deposits/installments, family requirements continuation, autopay, and roster outcomes; coordinate with C to wire that adapter into the evaluations router.
3. Coordinate with C to permit audited Files downloads for assigned evaluators only while the participant's current media consent is granted; keep direct/public file URLs unavailable.
4. Make offer acceptance idempotent under concurrent requests, returning the already-created checkout for a repeated acceptance with the same idempotency key.
5. Add/run the live offer acceptance journey for deposit, remaining autopay, roster placement, decline, and freed capacity; retain the existing offline scoring and placement journeys.
6. Run targeted module and web tests, typecheck/lint, Chromium and WebKit mobile Playwright with axe, then the full SPRINT merge gate through `heavy.sh`. Merge to trunk only after the required gate passes.

Known failing tests: none known. The first commit-hook attempt found an unused `accountId` in `phase6.integration.test.ts`; it was removed before the successful commit. Full merge-gate tests and live checkout acceptance remain unrun, not known failures.

Open requests:
- E: deliver and expose the offer-to-registration checkout adapter with deposit/installment/autopay and family checkout continuation.
- C: wire the adapter into the router; provide consent-sensitive, audited assigned-evaluator photo file access.

Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_f`, `PORT_OFFSET=600`.

HANDED OFF 13:13
