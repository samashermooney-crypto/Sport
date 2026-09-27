# Track D — design system

Status: working
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Shared UI and shell are implemented; awaiting `/__ui` mount from A to capture parity screenshots.
Ready for integration: none
Requests to other tracks: A: mount `web/src/ui/dev/Showcase.tsx` at dev-only `/__ui` (2026-09-26); integrator: add `recharts` and TipTap packages for the specified Chart and RichTextEditor (2026-09-26).
Blocked on: Auth restyle waits for Track A identity screens (task 3/17) to be marked done; `/__ui` screenshot baselines wait for A's route mount.

Completed: queue 1 reference capture/tokens; queue 2 primitives; queue 3 controls, overlays, calendar, chart, board, bracket, chat; queue 5 chrome, mobile tabs, command palette and global search shell.
Completed: queue 4 token/sanitizer tests and screenshot parity spec; screenshot baselines await `/__ui` route from A.
Self-review: preserved frozen token values and legacy colors, dimensions, fonts, modal, tables, badges and page-header styling.
Self-review: keyboard alternatives, visible focus, responsive card table, reduced-motion handling and native dialog focus restoration are present.
Self-review: Chart uses a token-colored native bar view and RichTextEditor ports legacy allow-list pending integrator dependencies for specified Recharts/TipTap implementations.
