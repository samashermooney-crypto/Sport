# Track D — design system

Status: ready-for-integration
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Track D queue complete; identity screens were restyled after Track A marked them stable (task 3/17).
Ready for integration: 195e30e..HEAD — shared primitives, extended components, design parity coverage, shell navigation, and auth controls are ready for dependent screens.
Requests to other tracks: none; the dev showcase route and generated types are integrated on trunk.
Blocked on: None.
Completed: Queue 1 reference capture and token snapshot; queue 2 shared primitives and initial tests.
Completed: Queue 3 extended controls, overlays, calendar, chart, rich text, signature, QR, print, board, bracket and chat components.
Completed: Queue 4 parity suite and queue 5 mobile tabs, command palette and global search shell.
Completed: Queue 6 auth restyle; auth fields, buttons, links, checkboxes, and select controls now use shared primitives while retaining the captured sign-in frame.
Self-review: `tokens.css` and `tokens.json` retain captured legacy values; DEC-028 records the only contrast adjustments, with no palette or type scale changes.
Self-review: `/__ui` is development-only and route discovery uses `routes.tsx`/`nav.ts` through the generated registry.
Self-review: Board moves have a keyboard alternative; calendar views, shell shortcuts, mobile overflow, 44px touch targets and axe checks have targeted coverage.
Verification: `npm run typecheck`, `npm run lint`, `npm test` (431 passed, 1 skipped), `npm run build`, `npm run registry`, and `npm run openapi` pass. Full browser suite: 16 passed and 4 project skips, including sign-in journeys and design parity on Chromium and WebKit mobile. Fresh e2e migrations and seed completed; source references are Chromium captures.
