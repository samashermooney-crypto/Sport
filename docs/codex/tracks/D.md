# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Ready for integration: local range `195e30e..HEAD` contains reusable primitives and Phase 14/16 work. D typecheck, lint, build, SSR/Lighthouse, and Chromium parity/Action Center checks pass; the full merge gate is currently blocked by the Track E registration test failure listed below.

## Current

Design system queues 1–6 are implemented. The current design tokens and macOS references are unchanged.

The Linux parity baseline was captured from GitHub Actions runner `ubuntu24/20260920.314.1`, Playwright 1.63.0, Chromium 153.0.8010.12, WebKit 26.6, and recorded font package versions. I downloaded the Playwright artifacts from runs `36357792018` (`9381acd`) and `36489602298` (`91614aa`). In the latest report, the failing expected PNGs match `origin/rebuild/trunk`; the CI actual PNGs match local `rebuild/trunk` and this branch byte-for-byte. The exact expected-to-actual raw differing-pixel counts are 58 (`ui-core-1440`), 83 (`ui-feedback-390`), and 1,455 (`ui-controls-390` WebKit mobile). The 390px/1440px legacy-shell comparisons pass, so the old 7.51% shell mismatch is not a current layout regression. Corrected Linux references are already on local `rebuild/trunk` at `6dbb0e2a` and this branch; GitHub's branch ref still resolves to `91614aa`. No tolerance, token-equality assertion, macOS reference, or design token changed.

Phase 14 implementation includes curated report datasets, role-filtered builders and presets, CSV/XLSX and PDF output, saved/scheduled reports, dashboards and role-filtered Action Center queues; website CMS/news, generated Programs and Schedule routes, SEO metadata/sitemap/structured events, domain verification APIs, embeds, and SSR renderers; organization ZIP export; privacy requests; and retention sweep. The public SSR router is tested directly, but Track C must wire its `/site` mount and verified custom-domain ingress through the shared app/module contract.

Lighthouse 13.5.0 mobile-default audits used Playwright’s bundled Chromium, a synthetic published organization with one public program/event, and the direct `createSiteSsrRouter` mount. Results: home **98/100/100**, Programs **99/100/100**, Schedule **99/100/100** (Performance/Accessibility/SEO). The first run exposed a 0.239 CLS from late Open Sans subset loads; SSR now preconnects and preloads the existing Latin and Latin Extended files without changing the site CSS or typeface. Audit JSON was saved under `/private/tmp/athlentry-lighthouse/reports/`.

Phase 16 §3: chart/report alternatives are semantic tables, calendars and boards are named, and boards expose a tested keyboard move alternative. English/Spanish completeness and email translation checks are automated. The accessibility statement appears on marketing and public-site footers. `docs/qa/ACCESSIBILITY.md` lists 27 manual keyboard journeys; the human keyboard pass remains open. Phase 16 §5 legal/trust pages are drafts, watermarked until `LEGAL_DOCS_APPROVED=true`; the Privacy draft names COPPA and qualifies the FERPA note. Phase 16 §6 landing, pricing, and README copy describes implemented behavior.

## Completed

- Queue 1–2: captured legacy references and published primitives in early batches.
- Queue 3: DateInput, TimeInput, DateRange, MoneyInput, PhoneInput, Combobox, FileUpload, Avatar, Tag, DataList, Stepper, Drawer, Sheet, Pagination, Calendar views/resource view, Timeline, StatTile, Chart, RichTextEditor, SignaturePad, QRCode, PrintLayout, keyboard-accessible Board, Bracket, and Chat thread.
- Queue 4–6: design parity suite, mobile bottom tab bar, command palette/global search shell, and shared auth controls.
- Phase 14 reports: sensitive columns remain role-gated; previews cap at 200 rows; scheduled delivery uses local time and secure links where needed. Board PDF is aggregate-only and reuses report access checks.
- Phase 14 privacy: access export is step-up gated; correction/deletion is reviewed; anonymization retains and pseudonymizes financial/waiver evidence; retention jobs are scoped and audited.
- Phase 16 accessibility additions: screen-reader chart tables, calendar/board labels, keyboard board movement, accessibility statement, and English/Spanish completeness tests.
- Linux parity references and runner provenance are on local `rebuild/trunk`; no tolerance or token-equality changes.

## Recent checks

- `server/src/modules/website/service.integration.test.ts`: 10/10 pass after adding assertions for SSR font preloads.
- `web/src/marketing/LegalPage.test.tsx`: 10/10 pass, including the review watermark on all seven public legal drafts; changed-path ESLint passes.
- `e2e/design/legal-drafts.spec.ts`: 2/2 Chromium journeys pass after registering `/welcome`, `/pricing`, and `/legal/:slug` through the generated web feature registry; all seven legal routes show the draft watermark and landing/pricing navigation reaches the sign-in entry point.
- `e2e/action-center.spec.ts`: 1/1 database-backed Chromium journey confirms the owner can keyboard-focus and activate mark-all-read with Enter; the submission updates and its Action Center card clears.
- New marketing route files pass full typecheck, lint, and production build. The prior run's downloaded CI actuals were compared pixel-for-pixel against all three corrected Linux references.
- Lighthouse mobile: home 98/100/100; Programs 99/100/100; Schedule 99/100/100.
- Latest design parity browser run: 14 passed, 4 WebKit skips; desktop and mobile shell parity, axe, component screenshots, calendar interactions, board keyboard movement, and global search passed.
- After the latest font/legal changes: full typecheck, full lint, and production build pass. Website SSR integration passes 10/10; Chromium parity and Action Center journeys pass 10/10.
- On the current D branch, `npm run typecheck` passes after removing unused report/action-center exports and two empty nested nav files. `npm run knip` no longer reports D-owned files or exports; remaining findings are two evaluation nav files (Tracks F/I) and 12 exports/types in shared export/report/website schemas. No shared or evaluation files were changed.
- Latest full `npm test`: 306 files passed, 1 skipped; 1,095 tests passed, 1 skipped; one unrelated Track E failure in `server/test/registration/team-entries.test.ts`: `stableUuid` throws “UUID digest is incomplete”.
- Latest full E2E: 111 passed, 10 skipped, 1 unrelated Track A WebKit-mobile sign-in failure at `e2e/sign-in.spec.ts:151` (“Save these 10 recovery codes now” not found). D parity and the Action Center journey pass.

## Exact next steps

1. Close remaining Phase 14 integration gaps: Track C to mount `createSiteSsrRouter` at `/site`, route verified custom domains, and wire Action Center/export jobs. Retest Lighthouse on the integrated routes.
2. Verify remaining Action Center actions and dashboard/PDF role access on the current isolated schema.
3. Complete the documented manual keyboard journeys where roles/routes are available; preserve failures as specific track requests.
4. Merge D changes to local `rebuild/trunk` with the self-merge gate when the trunk lock is free and cross-track test failures are resolved. The local trunk already contains the corrected Linux references; the orchestrator handles publishing.

## Open requests and blockers

- Track C: permit non-API `extraRouters` in the shared module contract and mount `createSiteSsrRouter` at `/site`; route verified custom-domain hosts; wire Action Center/export routes and jobs.
- Track E: fix `server/test/registration/team-entries.test.ts` (`stableUuid` “UUID digest is incomplete”), currently failing the full unit suite.
- Track A: investigate the WebKit-mobile recovery-code sign-in E2E failure in `e2e/sign-in.spec.ts`.
- Cross-track Knip: Tracks F/I should wire or remove `web/src/console/evaluations/nav.ts` and `web/src/portal/evaluations/nav.ts`; the shared schema owner should consume or remove the 12 currently unused exports/types reported by `npm run knip` (`shared/src/schemas/{exports,reports,website}.ts`).
- Manual 27-journey keyboard review and integrated-route Lighthouse recheck remain open.

`COMPOSE_PROJECT_NAME=athlentry_d_finish`; `PORT_OFFSET=2000`.
