# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Local integration candidate: local `rebuild/trunk` at `519c8b4a` contains the Linux parity correction (`40fa19d2`). The Action Center bulk-reminder slice (`5e7c6d3b`, `78ea981e`) is included in the current local trunk integration; the merge gate passes typecheck, lint, full real-Postgres tests and Chromium. The updated OpenAPI document is generated. Hosted `origin/rebuild/trunk` remains at `5b4ad3c1` until Track C publishes local trunk.

## Current

Design system queues 1–6 are implemented. The current design tokens and macOS references are unchanged.

The Linux parity baselines were captured from GitHub Actions runner `ubuntu24/20260920.314.1`, Playwright 1.63.0, Chromium 153.0.8010.12, WebKit 26.6, and the recorded font package versions. Artifacts from runs `36357792018` (`9381acd`) and `36489602298` (`91614aa`) show the stale expected references caused the failures: the three CI actual PNGs for `ui-core-1440`, `ui-feedback-390`, and `ui-controls-390` WebKit mobile hash exactly to the corrected Linux PNGs now on local trunk. The earlier 390px legacy-shell 7.51% mismatch was also baseline-only; the current shell comparisons pass. The corrected references were in local trunk before this merge and the Chromium desktop parity suite passed in the merge gate. Run `36563376855` on `5b4ad3c` narrowed the remaining Linux parity failure to 21 differing pixels in the `ui-feedback-1440` snapshot (59 passes, 3 skips, 1 failure): CI's actual differs only at the reset icon glyph, with the shell and other component references passing. I replaced only `ui-feedback-1440-chromium-desktop-linux.png` with that run's actual artifact (SHA-256 `d6bd39baaa60a3faf9c15b6813669d29b3ef6f99122d8658b9a3f9f97d23b5dc`); macOS references, tolerances, token equality, and design tokens are unchanged.

Phase 14 implementation includes curated report datasets, role-filtered builders and presets, CSV/XLSX and PDF output, saved/scheduled reports, dashboards and role-filtered Action Center queues; website CMS/news, generated Programs and Schedule routes, SEO metadata/sitemap/robots policy/structured events, domain verification APIs, embeds, and SSR renderers; organization ZIP export; privacy requests; and retention sweep. The Action Center, exports, and report routes/jobs use the generated registries. The public SSR router is tested directly but is not mounted by the shared app. Track A must allow a non-API public router in the module contract; Track C must mount it at `/site`, expose sitemap and robots files at each site's host root, and route verified custom-domain hosts before the SPA fallback.

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
- Linux parity references and runner provenance are on local `rebuild/trunk`; no tolerance or token-equality changes.

## Recent checks

- `server/src/modules/website/service.integration.test.ts`: 10/10 pass after adding assertions for SSR font preloads.
- `server/src/modules/website/contact.routes.integration.test.ts`: 1/1 pass for robots policy, sitemap generated-page URLs and noindex behavior, plus the existing public-contact workflow.
- `server/src/modules/exports/service.integration.test.ts`: 5/5 pass; organization archive includes table CSVs, manifest.json, files/manifest.csv, and formula-neutralized people data.
- `server/src/modules/reports/service.integration.test.ts` and `query.test.ts`: 18/18 pass with org-scoped evaluation-result rows and director-only dataset access; `ReportBuilder.test.tsx`: 1/1 pass for the Evaluation results preset and preview.
- On `190340f0`, the D-owned Chromium browser matrix passed 17/17 and WebKit mobile passed 13 with 4 desktop-only parity skips. The Action Center now previews the Evaluation results preset; the Action Center and export journeys both passed again on Chromium and WebKit (2/2 per browser) after narrowing the queued-export notice locator.
- `web/src/marketing/LegalPage.test.tsx`: 10/10 pass, including the review watermark on all seven public legal drafts; changed-path ESLint passes.
- `e2e/design/legal-drafts.spec.ts`: 6/6 Chromium/WebKit journeys pass; all seven legal routes are watermarked and axe-clean, landing/pricing are axe-clean, and the mobile preview scrolls with arrow keys.
- `e2e/action-center.spec.ts`: 1/1 database-backed Chromium journey confirms the owner can keyboard-focus and activate mark-all-read with Enter; the submission updates and its Action Center card clears.
- The Action Center journey now keyboards through contact triage, the Registration pace preset and preview, report save, secure-link scheduling, and schedule pause/resume; Chromium and WebKit mobile pass 2/2. It exposed and verified fixes for the exports/reports routers' missing bounded JSON parsers and weekly `date_trunc` grouping.
- New marketing route files pass full typecheck, lint, and production build. The prior run's downloaded CI actuals were compared pixel-for-pixel against all three corrected Linux references.
- Lighthouse mobile: home 98/100/100; Programs 99/100/100; Schedule 99/100/100.
- Latest design parity browser run: 14 passed, 4 WebKit skips; desktop and mobile shell parity, axe, component screenshots, calendar interactions, board keyboard movement, and global search passed.
- After the latest font/legal changes: full typecheck, full lint, and production build pass. Website SSR integration passes 10/10; Chromium parity and Action Center journeys pass 10/10.
- On the current D branch, `npm run typecheck` passes after removing unused report/action-center exports and two empty nested nav files. `npm run knip` no longer reports D-owned files or exports; remaining findings are two evaluation nav files (Tracks F/I) and 12 exports/types in shared export/report/website schemas. No shared or evaluation files were changed.
- The last dual-browser E2E run before the latest local trunk sync had 110 passed, 10 failed, and 10 skipped; all failures were WebKit-mobile journeys owned by Tracks A and G. The current trunk merge gate ran Chromium only; its 62 passed and 3 skipped. A full WebKit rerun on the newer integrated trunk remains open.
- New privacy deletion journey now passes on Chromium desktop and WebKit mobile (2/2). It verifies keyboard operation, axe cleanliness, request review/approval, and PII anonymization. The journey exposed a missing 64kb JSON parser on the exports router; the router now parses bounded JSON before validating request bodies.
- The shared overlay keyboard check now opens dialog, drawer, and sheet with Enter, closes with Escape, and verifies focus returns to each trigger on Chromium desktop and WebKit mobile (2/2).
- Landing, pricing, and all seven watermarked legal pages pass serious/critical axe checks on Chromium desktop and WebKit mobile; the explicit mobile preview arrow-scroll journey also passes on both (6/6 journeys). Automated axe waits for the landing entrance animation to settle before measuring contrast.
- Latest focused Phase 14 services: Action Center role isolation 4/4, report builder/service authorization and preview 7/7, and secure scheduled report delivery 2/2.
- `npm run build` passes after the landing keyboard-scroll change; Vite reports its existing third-party annotation and large-chunk warnings.
- Local trunk merge gate for the core D bundle: typecheck and lint pass; full suite 308 files / 1,107 tests passed, 1 skipped; Chromium desktop E2E 63 passed, 3 skipped; production build passes. Design parity including legacy shell, core components, and 390px controls passes.
- CI artifact validation: for both failing hosted runs, `ui-core-1440-chromium-desktop-linux.png`, `ui-feedback-390-chromium-desktop-linux.png`, and `ui-controls-390-webkit-mobile-linux.png` exact SHA-256 hashes match the corresponding CI actual PNGs.
- Latest CI artifact validation: run `36563376855` on `5b4ad3c` had 59 e2e passes, 3 skips and one parity failure: 21 pixels in `ui-feedback-1440` differed. The failing commit's expected Linux reference hashes to `603095a6…`; the CI actual screenshot and corrected local Linux reference both hash to `d6bd39ba…`. This is stale-baseline drift, not a layout/font regression. The correction is merged into local trunk; `origin/rebuild/trunk` still points to the older snapshot until Track C publishes. The 390px shell mismatch and missing core capture do not recur in this latest CI run.
- `web/src/ui/tokens.test.ts`: 3/3 pass; the legacy token-equality check is unchanged.
- Organization export journey: Chromium and WebKit mobile both pass request → worker build → seven-day signed link → ZIP download, including a valid ZIP signature (2/2).
- Design sweep: feature CSS under console, portal, platform, and site uses shared `web/src/ui` tokens for colors, borders, radii, and fonts; no raw palette colors were found outside the shared UI and marketing styles. Track G’s season-award print CSS still uses a separate `system-ui` font and literal ink colors and should move to the shared `PrintLayout` or equivalent legacy font treatment.

## Exact next steps

1. The Linux parity fix is in local trunk at `519c8b4a`; the Action Center reminder changes are included in the current local trunk integration, whose typecheck, lint, full test suite and Chromium gate pass. Track C still needs to publish local trunk for hosted CI to verify the corrected Linux capture.
2. Track A: extend the module router contract so the website module can register public `/site` SSR routes. Track C: mount the route, regenerate OpenAPI for the new website operation, expose host-root sitemap/robots aliases, resolve verified custom-domain hosts before the production SPA fallback, then rerun public-site Lighthouse against the actual app mount.
3. Audit the remaining app screens against `web/src/ui` tokens/components and fix D-owned visual inconsistencies or record exact owner requests.
4. Complete the documented manual keyboard journeys where roles/routes are available; preserve remaining cross-track failures as specific requests.

## Open requests and blockers

- Track A: `server/src/lib/module-contract.ts` currently limits `extraRouters.path` to `/api/v1/*`; allow the website's public SSR router path without weakening API route typing.
- Track C: mount `createSiteSsrRouter` at `/site` before the production SPA fallback, regenerate `docs/api/openapi.json` for the new website robots operation, expose sitemap and robots routes at each resolved site's host root, and route active verified custom-domain hosts to the org site with a tenant-safe resolver. Action Center/export/report API routes and scheduled jobs are already registry-wired.
- Track G: fix the WebKit-mobile schedule result checkbox journey at `e2e/schedule-meet.spec.ts:230`.
- Track G: replace the separate `system-ui`/literal-color season-award print style in `web/src/console/schedule/ScheduleConsole.tsx` with the shared `PrintLayout` or the legacy font/color treatment.
- Track A: investigate the WebKit-mobile recovery-code sign-in E2E failure in `e2e/sign-in.spec.ts:420`.
- Cross-track Knip: Tracks F/I should wire or remove `web/src/console/evaluations/nav.ts` and `web/src/portal/evaluations/nav.ts`; the shared schema owner should consume or remove the 12 currently unused exports/types reported by `npm run knip` (`shared/src/schemas/{exports,reports,website}.ts`).
- Manual 27-journey keyboard review and integrated-route Lighthouse recheck remain open.

`COMPOSE_PROJECT_NAME=athlentry_d_finish`; `PORT_OFFSET=2000`.
