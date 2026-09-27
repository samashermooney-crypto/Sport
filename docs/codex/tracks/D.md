# Track D — design system

Status: ready-for-integration
Model: GPT-6 Luna
Branch: `track/d-design`
Current: All Track D queue items 1–6 are complete; the dev-only showcase is mounted through the generated registry.
Ready for integration: 195e30e..HEAD — primitives, extended components, parity coverage, shell navigation and auth controls are ready for dependent screens.
Requests to other tracks: Track A — latest observed `rebuild/trunk` (`fd46684`) fails the staged ESLint hook in `memberRoles.ts`, `ownershipTransfer.ts` and `orgs/routes.ts`; fix before full-gate integration. `/__ui` is picked up through `web/src/ui/routes.tsx`.
Blocked on: None for Track D.
Completed: Queue 1 legacy reference captures and token snapshot; queue 2 primitives published in early batches with initial tests.
Completed: Queue 3 extended controls, overlays, calendar views/resource grid, chart, rich text, signature, QR, print, keyboard-accessible board, bracket and chat components.
Completed: Queue 4 parity suite; queue 5 mobile bottom tabs, command palette and global search shell.
Completed: Queue 6 auth controls restyled through shared components after Track A marked identity screens stable.
Self-review: `tokens.css` and `tokens.json` retain captured legacy values and fonts; accessibility-only adjustments use existing tokens (DEC-029, DEC-031) and the mobile modal touch-target adjustment is logged in DEC-030.
Self-review: `/__ui` is dev-only and registry-discovered; chart tones are token-backed; no CSS framework or styled component library is used.
Self-review: Desktop/mobile axe checks, 44px targets, modal escape behavior, keyboard tabs, calendar views and board keyboard moves are covered by the parity suite.
Verification: typecheck, lint, `npm test` (439 passed, 1 skipped), build (149.63 KB gzip main bundle), registry, OpenAPI and database codegen pass; full Playwright: 20 passed, 4 expected skips.
Track D complete.
