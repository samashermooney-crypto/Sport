# Track D — design system

Status: ready-for-integration
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Queues 3–5 are complete; auth restyle remains gated until Track A marks identity screens done.
Ready for integration: 195e30e..HEAD — primitives, extended components, parity coverage and shell navigation are available for dependent screens.
Requests to other tracks: none; the dev showcase route request is resolved in this branch.
Blocked on: Auth restyle remains gated until Track A marks identity screens done (task 3/17); this does not block merging shared UI work.
Completed: Queue 1 reference capture and token snapshot; queue 2 shared primitives and initial tests.
Completed: Queue 3 extended controls, overlays, calendar, chart, rich text, signature, QR, print, board, bracket and chat components.
Completed: Queue 4 parity suite and queue 5 mobile tabs, command palette and global search shell; parity run 5 passed, 3 WebKit-mobile cases skipped by project guards.
Self-review: `tokens.css` and `tokens.json` retain the captured legacy values; no palette or type scale changes.
Self-review: `/__ui` is development-only and route discovery uses `routes.tsx`/`nav.ts` through the generated registry.
Self-review: Board moves have a keyboard-select alternative; shell shortcuts, mobile overflow and calendar modes have targeted coverage.
Verification: `npm run typecheck`, `npm run lint`, `npm test` (54), `npm run build`, `npm run registry`, focused UI tests (6), and D parity suite pass; `format:check` reports only six unchanged legacy mockup HTML files.
