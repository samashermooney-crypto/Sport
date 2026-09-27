# Track D — design system

Status: working
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Queue 3 implementation and parity verification are in progress; `/__ui` is mounted through the generated feature registry.
Ready for integration: 195e30e..HEAD — shared primitives and the frozen design tokens are available for dependent screens.
Requests to other tracks: none; the dev showcase route request is resolved in this branch.
Blocked on: Auth restyle remains gated until Track A marks identity screens done (task 3/17).
Completed: Queue 1 reference capture and token snapshot; queue 2 shared primitives and initial tests.
Completed: Queue 3 extended controls, overlays, calendar, chart, rich text, signature, QR, print, board, bracket and chat components.
Completed: Queue 4 parity suite and queue 5 mobile tabs, command palette and global search shell; screenshots await final verification.
Self-review: `tokens.css` and `tokens.json` retain the captured legacy values; no palette or type scale changes.
Self-review: `/__ui` is development-only and route discovery uses `routes.tsx`/`nav.ts` through the generated registry.
Self-review: Board moves have a keyboard-select alternative; shell shortcuts, mobile overflow and calendar modes have targeted coverage.
