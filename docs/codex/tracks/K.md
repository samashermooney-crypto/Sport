# Track K — onboarding, imports, demo data, help, and optional AI

Status: working
Branch: `track/k-growth`
Current: merged `rebuild/trunk` at `2ac58d6` (merge commit `0b96e8b`); reviewed the `wip(engine-switch)` implementation and added Phase 15 route/schema, rollback, seed, and browser coverage.
Ready for integration: no; latest trunk reconciliation, all seed-profile render checks, full merge gate, and cross-track schema/wiring reconciliation remain.
Requests to other tracks: A — reconcile Phase 15 import adapter/job additions in `imports/module.ts` against the latest core on each merge and confirm the split between the existing People import screen and K extended import screen; H — confirm volunteer role/shift/signup columns and status values; C — keep K route/nav entries in generated registries, derive `VITE_AI_ENABLED` only from the configured provider/key, add raw binary request-body support to the OpenAPI generator, and expose the global Help center/contextual links; E — expose a test Stripe gateway base URL or injection point so the onboarding journey uses stripe-mock through the connect route; D — confirm the persisted published-site signal and final onboarding destination; B — confirm canonical sports/program/facility paths as they land.
Blocked on: none; K work continues against the published route and import contracts while those requests are pending.

## Delivery and verification

- Phase 15 work is in the K-owned onboarding, help, and AI modules; K-specific import routes are registered through `imports/module.ts` as an additive `extraRouters` adapter and `phase15_import_*` tables extend A's engine without replacing its repository, routes, or tables.
- `web/src/console/onboarding/`, `web/src/console/help/`, and `web/src/portal/help/` contain K's screens and route/nav declarations. `web/src/ui/OrgShell.tsx` is untouched; C owns generated router and shell wiring.
- Self-review: tenant reads/writes use `withOrg`; imports enforce role checks and same-origin writes, cap uploads at 20 MB/20,000 rows, keep duplicate choice explicit, and record reversible targets. Historical money is external and rollback retains financial/compliance evidence.
- Self-review: AI is disabled without a configured provider/key; draft application is explicit, prompts redact contact data, family chat is grounded in published org content and refuses child-specific questions, and usage is audited.
- Self-review: help articles use generic competitor export language; demo identities use fictional names and `example.test`; current-stack checks still need to prove all seed areas and browser journeys.

Verification so far: `npm run typecheck`, `npm run lint`, focused Phase 15 server tests (18/18), disabled-AI web test, and both Phase 15 Chromium journeys pass; migration and route/OpenAPI registries regenerate cleanly. The full import wizard was exercised for teams, rosters, and ZIP credentials with rollback.

Remaining: run the WebKit mobile journey, verify all seed profiles under two minutes and their matching console areas, reconcile the latest trunk interfaces, run the required heavy.sh merge gate, then merge to `rebuild/trunk` under the shared lock.
