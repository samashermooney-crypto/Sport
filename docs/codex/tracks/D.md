# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `fix/d`
Working from the 10-hour integration plan. `track/integration` is at `2ec7c9a2`; `ci/integration.txt` still reports run `36653551397` on older head `c0dd2e28`, before the latest D parity and storage-injection commits. D's newer fixes are committed on `fix/d` and await hosted CI. The old per-track trunk merge notes below are historical.

## Current

Design system queues 1–6 are implemented. The current design tokens and macOS references are unchanged.

The e2e job captures Linux legacy admin and public-site shell references on its `ubuntu-24.04` runner before comparison, and selects those references for Linux comparisons. CI uploads the generated references with runner/font/browser provenance and shell image hashes on every run; failures additionally upload `test-results/` and the Playwright report. CI does not automatically rewrite component snapshots. Awaiting integration-branch CI for the reviewed Linux component snapshot and font-settling updates now committed on `fix/d`.

Earlier Linux component references were captured in `mcr.microsoft.com/playwright:v1.63.0-noble`; hosted CI uses the Ubuntu runner directly. Run `36653551397` reports `ubuntu24/20260920.314.1`, Playwright 1.63.0, Chromium 153.0.8010.12, WebKit 26.6 and the recorded font package versions. That run's shell references matched and the `ui-core-1440` Linux snapshot existed. Its only D parity failure was `ui-team-1440`: three retries produced byte-identical actual images with 21 changed pixels confined to native select chevrons. The reviewed actual image from that runner now replaces the Linux snapshot in `fix/d`. macOS references, tolerances, token equality, and design tokens remain unchanged.

Phase 14 implementation includes curated report datasets, role-filtered builders and presets, CSV/XLSX and PDF output, saved/scheduled reports, dashboards and role-filtered Action Center queues; website CMS/news, generated Programs and Schedule routes, SEO metadata/sitemap/robots policy/structured events, domain verification APIs, embeds, and SSR renderers; organization ZIP export; privacy requests; and retention sweep. The Action Center, exports, and report routes/jobs use the generated registries. The website module registers its public router, and `createApp` mounts it before API guards and the production SPA fallback. Its integration test exercises the shared app for platform subdomains, verified custom domains, host-root sitemap/robots files, and rejection of a pending domain. CI validation and the Lighthouse repeat against this mounted path remain open.

Lighthouse 13.5.0 mobile-default audits used Playwright’s bundled Chromium, a synthetic published organization with one public program/event, and the direct `createSiteSsrRouter` mount. Results: home **98/100/100**, Programs **99/100/100**, Schedule **99/100/100** (Performance/Accessibility/SEO); raw reports and the device profile are committed under `perf/results/2026-09-28-phase14-lighthouse/`. The first run exposed a 0.239 CLS from late Open Sans subset loads; SSR now preconnects and preloads the existing Latin and Latin Extended files without changing the site CSS or typeface. These scores must be repeated after `/site` is mounted by the shared app.

Phase 16 §3: chart/report alternatives are semantic tables, calendars and boards are named, and boards expose a tested keyboard move alternative. English/Spanish completeness and email translation checks are automated. The accessibility statement appears on marketing and public-site footers. The marketing, pricing, and legal pages now have Chromium/WebKit axe journeys; the landing's low-contrast manifesto heading and demo chrome, and its mobile preview scrolling, were corrected without changing shared tokens or layout values (DEC-124). The preview now announces Left/Right arrow instructions and scrolls by keyboard. `docs/qa/ACCESSIBILITY.md` lists 27 manual keyboard journeys; the human keyboard pass remains open. Phase 16 §5 legal/trust pages are drafts, watermarked until `LEGAL_DOCS_APPROVED=true`; the Privacy draft names COPPA and qualifies the FERPA note. Phase 16 §6 landing, pricing, and README copy describes implemented behavior.

## Completed

- Queue 1–2: captured legacy references and published primitives in early batches.
- Queue 3: DateInput, TimeInput, DateRange, MoneyInput, PhoneInput, Combobox, FileUpload, Avatar, Tag, DataList, Stepper, Drawer, Sheet, Pagination, Calendar views/resource view, Timeline, StatTile, Chart, RichTextEditor, SignaturePad, QRCode, PrintLayout, keyboard-accessible Board, Bracket, and Chat thread.
- Queue 4–6: design parity suite, mobile bottom tab bar, command palette/global search shell, and shared auth controls.
- Action Center bulk actions: finance-authorized overdue-invoice and failed-autopay reminders, plus compliance-authorized staff reminders, send only unread-deduplicated in-app notifications; they do not send external messages or retry charges. Staff notices go only to a verified self-linked account. Server integration tests pass 8/8 and the UI test passes 3/3.
- Phase 14 reports: sensitive columns remain role-gated; evaluation results are available as a sensitive-tier standard report; previews cap at 200 rows; scheduled delivery uses local time and secure links where needed. Board PDF is aggregate-only and reuses report access checks.
- Phase 14 privacy: access export is step-up gated; correction/deletion is reviewed; anonymization retains and pseudonymizes financial/waiver evidence; retention jobs are scoped and audited.
- Phase 16 accessibility additions: screen-reader chart tables, calendar/board labels, keyboard board movement, keyboard-scrollable landing preview, accessibility statement, and English/Spanish completeness tests.
- Phase 16 landing/documentation: landing contrast and mobile preview keyboard access are axe-verified; README now covers the product, architecture, local commands, environment/deployment references, and the complete D18 exclusions.
- Linux legacy shell capture/provenance is on the integration head; the exact-hosted `ui-team-1440` snapshot refresh and font-settling change are on `fix/d` pending CI. No tolerance or token-equality changes.

## Recent checks

- On the current `fix/d` head, `heavy.sh npm run typecheck` and `heavy.sh npm run lint` pass after the storage-dependency and parity updates. The latest hosted report is still for `c0dd2e28` and has not evaluated the current D head.
- CI run `36648564282` on an older D head reported a 9.63% Linux 390px public-shell mismatch and component screenshot mismatches. In run `36653551397`, the same-runner shell capture passes; downloaded expected/actual/diff artifacts isolated one component-only select-chevron raster baseline mismatch, now corrected on `fix/d`.
- QA-ACC-055 fix and regression coverage: report grouping now classifies verified credentials with `expires_on < CURRENT_DATE` as expired, keeps the expiry date inclusive, treats `NULL` expiry as non-expiring, and excludes revoked rows from the denominator. The focused dashboard test passes; the Postgres integration regression is queued for CI.
- QA-ACC-056 implementation: the weekly retention sweep expires exports and revokes their links before deleting ZIP bytes, then tombstones file metadata. Storage/metadata failures remain retryable; the fake-storage regression covers a live export and a failed-delete retry. Typecheck and lint pass; database-backed execution awaits integration CI.
- QA-ACC-057 implementation: approved anonymization deletes photo bytes after commit and leaves a durable retry marker; credential files are tombstoned and retained through expiry plus one year (verification, issue, then creation date fallback), then purged by the weekly sweep. The regression covers failed photo deletion/retry, valid evidence retention, and expired evidence purge. Typecheck and lint pass; database-backed execution awaits integration CI.
- QA-ACC-058 D-side injection seam: export router, build-job handler, and retention-sweep handler now accept the configured `Storage`; the ZIP build/download and cleanup regressions use the injected adapter. Track C still needs to pass the same configured adapter to the router and worker handlers.
- QA-SEC-017 regression coverage: hostile organization identity, published news, and page strings are parsed from actual SSR responses; the test rejects active scripts, event-handler attributes, and executable URLs while validating the inert JSON-LD block. Typecheck and lint pass; database-backed execution awaits integration CI.
- `heavy.sh npm run typecheck` and `heavy.sh npm run lint` pass after the report update. `web/src/console/reports/ReportsDashboard.test.tsx` passes individually.
- `server/src/modules/website/service.integration.test.ts`: 10/10 pass after adding assertions for SSR font preloads.
- `server/src/modules/website/contact.routes.integration.test.ts`: 1/1 pass for robots policy, sitemap generated-page URLs and noindex behavior, plus the existing public-contact workflow.
- `server/src/modules/exports/service.integration.test.ts`: 5/5 pass; organization archive includes table CSVs, manifest.json, files/manifest.csv, and formula-neutralized people data.
- `server/src/modules/reports/service.integration.test.ts` and `query.test.ts`: 18/18 pass with org-scoped evaluation-result rows and director-only dataset access; `ReportBuilder.test.tsx`: 1/1 pass for the Evaluation results preset and preview.
- On `190340f0`, the D-owned Chromium browser matrix passed 17/17 and WebKit mobile passed 13 with 4 desktop-only parity skips. The Action Center now previews the Evaluation results preset; the Action Center and export journeys both passed again on Chromium and WebKit (2/2 per browser) after narrowing the queued-export notice locator.
- `web/src/marketing/LegalPage.test.tsx`: 10/10 pass, including the review watermark on all seven public legal drafts; changed-path ESLint passes.
- `e2e/design/legal-drafts.spec.ts`: 6/6 Chromium/WebKit journeys pass; all seven legal routes are watermarked and axe-clean, landing/pricing are axe-clean, and the mobile preview scrolls with arrow keys.
- `e2e/action-center.spec.ts`: 1/1 database-backed Chromium journey confirms the owner can keyboard-focus and activate mark-all-read with Enter; the submission updates and its Action Center card clears.
- The Action Center journey now sends an overdue-invoice reminder twice, verifies one in-app notification and an unread duplicate skip, and checks the destination payload. Its first run caught the missing bounded JSON parser on the mutation router; after adding it and moving the fixture date seven days back, the browser journey passes.
- The Action Center journey now keyboards through contact triage, the Registration pace preset and preview, report save, secure-link scheduling, and schedule pause/resume; Chromium and WebKit mobile pass 2/2. It exposed and verified fixes for the exports/reports routers' missing bounded JSON parsers and weekly `date_trunc` grouping.
- New marketing route files pass full typecheck, lint, and production build. The prior run's downloaded CI actuals were compared pixel-for-pixel against all three corrected Linux references.
- Lighthouse mobile: home 98/100/100; Programs 99/100/100; Schedule 99/100/100.
- Latest design parity browser run: 14 passed, 4 WebKit skips; desktop and mobile shell parity, axe, component screenshots, calendar interactions, board keyboard movement, and global search passed.
- After the latest font/legal changes: full typecheck, full lint, and production build pass. Website SSR integration passes 10/10; Chromium parity and Action Center journeys pass 10/10.
- On the latest integrated D branch, `npm run knip` exits clean after keeping the Action Center bulk-action enum internal; no D-owned unused exports or files remain.
- The last dual-browser E2E run before the latest local trunk sync had 110 passed, 10 failed, and 10 skipped; all failures were WebKit-mobile journeys owned by Tracks A and G. The current trunk merge gate ran Chromium only; its 62 passed and 3 skipped. A full WebKit rerun on the newer integrated trunk remains open.
- New privacy deletion journey now passes on Chromium desktop and WebKit mobile (2/2). It verifies keyboard operation, axe cleanliness, request review/approval, and PII anonymization. The journey exposed a missing 64kb JSON parser on the exports router; the router now parses bounded JSON before validating request bodies.
- The shared overlay keyboard check now opens dialog, drawer, and sheet with Enter, closes with Escape, and verifies focus returns to each trigger on Chromium desktop and WebKit mobile (2/2).
- Landing, pricing, and all seven watermarked legal pages pass serious/critical axe checks on Chromium desktop and WebKit mobile; the explicit mobile preview arrow-scroll journey also passes on both (6/6 journeys). Automated axe waits for the landing entrance animation to settle before measuring contrast.
- Latest focused Phase 14 services: Action Center role isolation 4/4, report builder/service authorization and preview 7/7, and secure scheduled report delivery 2/2.
- `npm run build` passes after the landing keyboard-scroll change; Vite reports its existing third-party annotation and large-chunk warnings.
- Local trunk merge gate for the core D bundle: typecheck and lint pass; full suite 308 files / 1,107 tests passed, 1 skipped; Chromium desktop E2E 63 passed, 3 skipped; production build passes. Design parity including legacy shell, core components, and 390px controls passes.
- CI artifact validation: for both failing hosted runs, `ui-core-1440-chromium-desktop-linux.png`, `ui-feedback-390-chromium-desktop-linux.png`, and `ui-controls-390-webkit-mobile-linux.png` exact SHA-256 hashes match the corresponding CI actual PNGs.
- Follow-up for Linux shell parity: the admin shell comparison now waits for `document.fonts.ready` after each viewport resize before capturing `.ui-topbar`, matching the public-site comparator and the hosted legacy capture's font settling. The 6.5% threshold and token equality check are unchanged; awaiting the next integration CI result.
- Run `36653551397` isolated the current component parity failure to `ui-team-1440`: the same 21 differing pixels appeared in all three retries and are confined to native select chevrons. The committed Linux snapshot was captured in a Playwright container; CI renders on hosted `ubuntu-24.04` (`ubuntu24/20260920.314.1`, Playwright 1.63.0, Chromium 153.0.8010.12). The stable actual screenshot from that runner replaces only `ui-team-1440-chromium-desktop-linux.png`; macOS and other snapshots remain unchanged. The run's generated Linux snapshot files include `ui-core-1440-chromium-desktop-linux.png`, so the earlier missing-file report is not present on this integration head.
- Prior CI artifact validation: run `36563376855` on `5b4ad3c` had 59 e2e passes, 3 skips and one parity failure: 21 pixels in `ui-feedback-1440` differed. The expected Linux reference hash was `603095a6…`; the CI actual screenshot and corrected Linux reference both hashed to `d6bd39ba…`, confirming runner-specific baseline drift.
- `web/src/ui/tokens.test.ts`: 3/3 pass; the legacy token-equality check is unchanged.
- Organization export journey: Chromium and WebKit mobile both pass request → worker build → seven-day signed link → ZIP download, including a valid ZIP signature (2/2).
- Design sweep: feature CSS under console, portal, platform, and site uses shared `web/src/ui` tokens for colors, borders, radii, and fonts; no raw palette colors were found outside the shared UI and marketing styles. Track G’s season-award print CSS still uses a separate `system-ui` font and literal ink colors and should move to the shared `PrintLayout` or equivalent legacy font treatment.

## Exact next steps

1. Read `ci/integration.txt` at the current integration head; confirm the runner capture succeeds, review any parity actual/expected/diff artifacts, and fix only proven Linux baseline drift or a real rendered regression.
2. Fix any D-owned console/website failures reported by integration CI; all six website console/embed test files pass individually on `fix/d`.
3. Finish the remaining D-owned Phase 14 QA requests for export expiry, privacy photo cleanup, stored-XSS coverage, and configured shared storage; the shared `/site` mount and custom-domain route are present on integration, pending hosted validation.
4. Rerun public-site Lighthouse against the shared `createApp` mount under CI, then complete the documented manual keyboard journeys where routes are available.

## Open requests and blockers

- Track A: `server/src/lib/module-contract.ts` currently limits `extraRouters.path` to `/api/v1/*`; allow the website's public SSR router path without weakening API route typing.
- Track C: mount `createSiteSsrRouter` at `/site` before the production SPA fallback, expose sitemap and robots routes at each resolved site's host root, and route active verified custom-domain hosts to the org site with a tenant-safe resolver. `docs/api/openapi.json` now includes the website robots and Action Center reminder operations. Action Center/export/report API routes and scheduled jobs are already registry-wired.
- Track G: fix the WebKit-mobile schedule result checkbox journey at `e2e/schedule-meet.spec.ts:230`.
- Track G: replace the separate `system-ui`/literal-color season-award print style in `web/src/console/schedule/ScheduleConsole.tsx` with the shared `PrintLayout` or the legacy font/color treatment.
- Track A: investigate the WebKit-mobile recovery-code sign-in E2E failure in `e2e/sign-in.spec.ts:420`.
- Manual 27-journey keyboard review and integrated-route Lighthouse recheck remain open.

`COMPOSE_PROJECT_NAME=athlentry_d_finish`; `PORT_OFFSET=2000`.

## Requests from QA

- QA-ACC-055: implementation and expired-before-sweep regression coverage are committed on `fix/d`; awaiting integration CI for the PostgreSQL case.
- QA-ACC-056: implementation and expired/live plus storage-delete retry coverage are on `fix/d`; awaiting database-backed integration CI.
- QA-ACC-057: implementation, retry coverage, and the validity-plus-one-year credential evidence rule are on `fix/d`; awaiting database-backed integration CI.
- QA-SEC-017: hostile-content SSR regression is on `fix/d`; awaiting database-backed integration CI.
- QA-ACC-058 (coordinate C): D's router and both scheduled job handlers accept the shared dependency object; C must pass the same configured adapter from web and worker startup, including the retention/privacy cleanup jobs. Integration coverage exercises build, download, and cleanup through injected storage; production wiring remains open.

- QA-ACC-065: implementation is present on `track/integration` (`website.moduleDefinition.publicRouter` is mounted by `createApp`); the website integration regression now uses the shared app and verifies a published site, verified custom domain, host-root SEO aliases, and pending-domain rejection. Await hosted validation and repeat Lighthouse against this mount; the currently committed scores use the direct router.
- QA-ACC-067: the 390px legacy-shell mismatch from run `36640228008` does not appear in run `36653551397`; that hosted report has no legacy-shell or public-site shell failure. The only D-owned visual failure is `ui-team-1440`, now re-baselined from the stable hosted Ubuntu actual in commit `ea9b9c7d`. Await CI for that fix. The earlier missing `ui-core-1440` Linux snapshot is present on integration `c0dd2e28`. Keep tolerances and design tokens unchanged. See `docs/codex/qa/DEFECTS.md`.
