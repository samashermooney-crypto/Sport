# Track D — design system

## Requests from QA

- QA-ACC-055: the new `credential-compliance` chart counts every `status = verified` record without accounting for `expires_on`; the shared compliance policy rejects a verified credential after its expiry date, while the expiry status job can lag. Include expiry validity in the as-of aggregation and test an overdue verified credential before the sweep. Finding is against off-trunk commit `36feadcc`; see `docs/codex/qa/DEFECTS.md`.
- QA-ACC-056: export ZIPs and their `files` rows are marked to expire after seven days, but the retention job never deletes them from storage; only download access expires. Remove expired export bytes and safely retire their file metadata while preserving audit evidence; add a fake-storage expiry regression. Finding is against off-trunk commit `36feadcc`; see `docs/codex/qa/DEFECTS.md`.
- QA-ACC-057: approved person anonymization clears references and tombstones the photo file row but does not remove the stored photo bytes. Erase those bytes through retryable storage cleanup while preserving audit/legal records; define a separate retention rule for credential evidence. Add fake-storage assertions. Finding is against off-trunk commit `36feadcc`; see `docs/codex/qa/DEFECTS.md`.
- QA-SEC-017: add an adversarial stored-XSS regression for public website SSR using persisted organization/news/page values. Static review found React text nodes and safe JSON-LD escaping, so this is a coverage gap rather than a confirmed exploit. Finding is against off-trunk commit `36feadcc`; see `docs/codex/qa/DEFECTS.md`.
- QA-ACC-058 (coordinate Track C): export job and download router construct `LocalDiskStorage` instead of using the configured shared S3-compatible adapter; separate worker/web filesystems can make completed exports unavailable. Inject shared storage across both paths and test build-to-download. Finding is against off-trunk commit `36feadcc`; see `docs/codex/qa/DEFECTS.md`.

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

## HANDOFF

Status at engine switch: Track D has not started Sprint Phase 14 or Phase 16 work. The branch includes the latest observed `rebuild/trunk` merge (`71ac3f8`) plus the committed Linux parity baseline and mobile shell adjustments. The branch is not ready to merge into trunk because the parity suite has two screenshot failures and the full merge gate has not passed. Track C was reported as fixing trunk CI.

Done:
- Added Linux-specific shell references and platform selection while preserving the macOS references, the 6.5% mismatch limit, and token-equality check (`5619852`).
- Adjusted mobile shell details to match the legacy appearance (`e31eacc`). Focused Mac shell parity passed. `npm run typecheck` and `npm run lint` passed after merging trunk.
- `/__ui` is registered in `web/src/ui/routes.tsx`; no Track A request is open for route registration.
- Chart and TipTap dependencies are already present in the merged package manifests (`c08e86b`).

In progress (exact paths):
- Linux baseline provenance needs correction and validation in `e2e/visual-reference/parity-baselines.json`, `e2e/visual-reference/dashboard-1440-linux.png`, and `e2e/visual-reference/dashboard-390-linux.png`. Current references were captured from `mcr.microsoft.com/playwright:v1.58.0-noble`, while the branch lockfile resolves Playwright 1.63.0. Pulling the matching v1.63.0 Linux image timed out. The Linux test has not passed under the lockfile's browser version.
- Full parity screenshot drift is recorded at `e2e/design/parity.spec.ts-snapshots/ui-scheduling-1440-chromium-desktop-darwin.png` and `e2e/design/parity.spec.ts-snapshots/ui-shell-topbar-390-chromium-desktop-darwin.png`; inspect and refresh only if the changes are confirmed intentional.
- Phase 14 implementation has not started. Assigned paths are the reports, action-center, website, and exports modules; reports, website, site, and home web surfaces; and migrations 7000–7999 as listed in SPRINT.md.

Exact next steps:
1. In a Linux environment using `mcr.microsoft.com/playwright:v1.63.0-noble` (linux/amd64), regenerate both legacy shell references, update their provenance metadata, and run the focused Linux `shell chrome` parity test. Keep the existing mismatch threshold, token-equality assertion, and macOS reference files unchanged.
2. Review the two named Darwin snapshot diffs, refresh snapshots only for confirmed intentional shell changes, then rerun the full design parity spec on Mac and Linux.
3. Once trunk CI is green and Track D's full merge gate passes, use the SPRINT.md self-merge protocol to integrate the ready local range. Current local range: `195e30e..HEAD`.
4. Implement the Phase 14 queue on the owned paths, including migrations 7000–7999, and update this track note as work lands.
5. At 13:30 local time, start Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README. Continue small commits and the scheduled self-merges.

Known failing or unverified checks:
- `npx playwright test --project=chromium-desktop e2e/design/parity.spec.ts`: 7 passed, 2 failed on the two Darwin snapshots named above (8 pixels for scheduling; 535 pixels for the 390px top bar).
- Linux shell parity was measured below threshold with the older container/browser, but was not rerun with the lockfile-matching Playwright 1.63.0 environment; current Linux baseline provenance is therefore provisional.
- The full SPRINT merge gate was not run and trunk integration was skipped.

Open requests: none. `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.

HANDED OFF 08:23
