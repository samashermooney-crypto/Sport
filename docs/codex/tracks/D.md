# Track D — design system

Status: ready-for-integration
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Queues 1–5 are complete; auth restyle is eligible after Track A marks identity screens done (task 3/17).
Ready for integration: 195e30e..HEAD — primitives, extended components, parity coverage and shell navigation are available for dependent screens.
Requests to other tracks: A — regenerate and commit `server/src/db/types.ts`; local `db:codegen` produced a 140-table refresh, outside D ownership.
Blocked on: None for queues 1–5; queue 6 auth restyle starts after Track A marks identity screens done (task 3/17).
Completed: Queue 1 reference capture and token snapshot; queue 2 shared primitives and initial tests.
Completed: Queue 3 extended controls, overlays, calendar, chart, rich text, signature, QR, print, board, bracket and chat components.
Completed: Queue 4 parity suite and queue 5 mobile tabs, command palette and global search shell; latest run 12 passed, 4 project skips.
Self-review: `tokens.css` and `tokens.json` retain captured legacy values; DEC-026 records the only contrast adjustments, with no palette or type scale changes.
Self-review: `/__ui` is development-only and route discovery uses `routes.tsx`/`nav.ts` through the generated registry.
Self-review: Board moves have a keyboard alternative; calendar views, shell shortcuts, mobile overflow, 44px touch targets and axe checks have targeted coverage.
Verification: `npm run typecheck`, `npm run lint`, `npm test` (343 passed, 1 skipped), `npm run build`, `npm run registry`, `npm run openapi`, `db:migrate`/`db:codegen`, and parity suite (12 passed, 4 project skips) pass; source references are Chromium captures.
