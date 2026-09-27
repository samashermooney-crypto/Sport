# Track K — Phase 15: onboarding, imports, demo data, help, AI assist

Status: working
Branch: `track/k-growth`
Worktree: `/Users/sammooney/Sport-k-growth`
Migrations: 8500–8999
Isolated stack: `COMPOSE_PROJECT_NAME=athlentry_k`, `PORT_OFFSET=1200` (1100 squatted by athlentry_c_sprint)

## Current

Merged rebuild/trunk at 4660724. No `imports` module exists on trunk or on
`track/a-core` — Phase 2 import engine is not built, so Track K is building the
full import framework (batches/rows/mapping-presets per 02 §R, C6/C7 rules) plus
the Phase 15 kinds inside `server/src/modules/imports/**` (explicitly within K
ownership per assignment).

## Ready for integration

none yet

## Requests to other tracks

- A — `server/src/modules/imports` does not exist on trunk; Track K is
  implementing the whole framework (people/households import engine +
  Phase 15 kinds). If A has unmerged imports work, coordinate before merging —
  K's implementation follows 02 §R + C6/C7 exactly.
- A — `web/src/console/Home.tsx` is yours; Track K renders the onboarding
  checklist at `/console/orgs/:orgId/onboarding` and offers a small
  `OnboardingChecklist` component you may embed on Home when ready.
- C — wiring note: Track K adds nested route spreads for
  `web/src/console/{onboarding,imports,help}` and `web/src/portal/help` in
  `web/src/console/routes.tsx` / `web/src/portal/routes.tsx` (one import + one
  spread line each, matching the existing audit/messages/money/safety pattern).
  Flag if you want ownership of those two lines.
- E — checklist item "Connect payments" links to your Stripe connect screen
  (`/console/orgs/:orgId/money` area); completion detects `payment_accounts`.
- B/D — checklist items link to your future canonical routes
  (programs wizard, facilities, website publish); links degrade gracefully to
  the closest existing screen until those land.

## Blocked on

none
