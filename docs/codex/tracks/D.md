# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Design system queues 1–6 are complete. Linux parity references and platform-specific shell lookup are on D in commit `5cf711c`. Regenerated references and showcase snapshots inside `mcr.microsoft.com/playwright:v1.63.0-noble` (`linux/amd64`) match the committed Linux snapshots; all 9 Chromium parity tests pass, including both 390px and 1440px legacy-shell comparisons, and the WebKit mobile screenshot case passes. The fresh legacy shell images have no pixels above the unchanged channel-difference threshold (maximum channel delta 1). The reported 7.51% delta was caused by the missing Linux reference files on trunk; no layout regression was found, and neither tolerance nor the token-equality test changed. The baseline script now preserves the root lockfile dependency tree by isolating legacy dependencies and warms Vite before capture. During trunk sync, migrations 7000 and 8000 collided on Phase 11-owned sponsor/fundraising tables and 7008/8010 duplicated FK index names; D-owned forward migrations 7009 and 7010 preserve the old tenant-scoped rows under legacy names and free canonical names. Migrations through 8010, DB codegen, registry generation, and OpenAPI generation now pass. The report API and builder support curated role-visible datasets, 200-row previews, typed filters, grouping and aggregates, saved-report role sharing, CSV/XLSX exports, local-time schedules with pause/resume, and standard presets for registration pace/program/division/age/gender/ZIP, year-over-year participant retention, revenue by program, receivables aging, credential status, installment forecast, attendance status, payout status, official pay, donations, volunteer completion, financial-aid awards, and uniform sizes. Website page editing, safe structured content, versioned revisions, public JSON/sitemap endpoints, an SSR renderer, public plans/pricing, and tenant-scoped settings/menu APIs and console are implemented. The org export API, worker job, secure expiring download links, ZIP builder, and organization home UI are implemented; their generated route/worker wiring is requested from C. Phase 16 landing/legal pages, English/Spanish website copy coverage, transactional-email translation coverage, keyboard review instructions, and README truthfulness are implemented. Action Center, remaining dashboards, website news/domains/embeds and generated pages, privacy workflow, and retention sweep remain.
Ready for integration: `195e30e..HEAD` is the current local D range. Typecheck and lint pass; the focused report query/dataset/builder suite passes 15/15 and the report/website/fundraising/sponsor database suite passes 17/17. The exact trunk merge gate is pending. Migration 7008 supplies Phase 14 FK indexes; 7009–7010 preserve its legacy fundraising website rows and indexes before Phase 11 tables apply.
Requests to other tracks: Track A — investigate `e2e/people.spec.ts` image upload assertion (the edited profile shows no image after upload); this is outside D ownership and currently fails the full desktop E2E gate. Track C — mount `createSiteSsrRouter` from `server/src/modules/website/public.ts` at `/site`; the current `ServerModule.extraRouters` contract only supports `/api/v1/*`. Wire Action Center and export routes with their worker jobs. The D branch includes generated Website/nested-web/OpenAPI registry entries; exports need the generated server, web, and OpenAPI entries added after module scan.
Blocked on: None.

Completed:
- Queue 1 legacy reference captures and token snapshot; queue 2 primitives published in early batches.
- Queue 3 extended controls, overlays, calendar views/resource grid, chart, rich text, signature, QR, print, keyboard-accessible board, bracket, and chat components.
- Queue 4 parity suite; queue 5 mobile bottom tabs, command palette, and global search shell; queue 6 shared auth controls.
- Linux parity references were generated using `mcr.microsoft.com/playwright:v1.63.0-noble` with `linux/amd64`. The 9-case design parity spec passed on both Mac and Linux; legacy references remain and the mismatch threshold and token-equality assertion are unchanged.
- On the current synced branch, the host Chromium desktop parity run passed 9/9; the pinned Linux Chromium run passed 9/9, including the 390px legacy shell comparison. CI run `36337698479` failed on the prior trunk commit because Linux snapshot files were absent; the baseline comparison passed in the target Linux image after selecting the Linux capture.
- Phase 14 migrations 7000–7010, generated DB types, report dataset/query/schema/service/router/module, CSV/XLSX serializers, ZIP helper, org-local schedule CRUD, durable outbox delivery, and per-recipient outcomes are present. D and H migrations through 8010 apply on the isolated Track D database, and the 246-table DB types have been regenerated.
- Website foundation: role-checked page editing, optimistic versions and revision history, public published-page JSON, sitemap output, structured safe-content schemas, a console editor, public page surface, legacy site CSS port, and an SSR document renderer. Focused schema tests pass 3/3 and the Postgres service tests pass 2/2 on a fresh isolated stack.
- Public pricing now lists only active plans and exposes only name, key, monthly cents, and the custom-pricing flag; the `/pricing` page renders that API response and handles loading, empty, and error states. Marketing pricing/legal/i18n tests pass 4/4 and website PostgreSQL service tests pass 3/3 on the fresh verification stack; focused ESLint and typecheck pass.
- Standard reports now include registration by gender and household ZIP/postal code. Their source columns remain Sensitive-tier and are only surfaced to roles allowed to query them. Year-over-year retention compares unique confirmed participants across adjacent calendar years, reports the previous cohort size, retained count and percentage, and uses the existing save/share/schedule/export flow. Fresh-stack report tests pass 22/22, including a fixture that verifies 2 prior participants, 1 retained participant and a 50% rate.
- Organization export now lists and requests tenant archives, requires an owner/admin membership and recent step-up authentication, queues a durable build job, writes tenant table CSVs and a file manifest into an expiring ZIP, and issues a hashed, single-use seven-day download token. The console home links to the export view. Fresh isolated-stack service tests pass 2/2, the UI test passes 1/1, focused ESLint passes, and `npm run typecheck` passes.

In progress (exact paths):
- `db/migrations/7000_website_core.sql`
- `db/migrations/7001_reports.sql`
- `db/migrations/7002_exports_privacy.sql`
- `db/migrations/7003_export_token_fix.sql`
- `server/src/db/types.ts`
- `server/src/modules/reports/query.ts`
- `server/src/modules/reports/policy.ts`
- `server/src/modules/reports/query.test.ts`
- `server/src/modules/reports/service.ts`
- `server/src/modules/reports/service.integration.test.ts`
- `server/src/modules/reports/routes.ts`
- `server/src/modules/reports/module.ts`
- `server/src/modules/reports/schedules.ts`
- `server/src/modules/reports/schedule-delivery.ts`
- `server/src/modules/reports/schedule-delivery.integration.test.ts`
- `server/src/modules/reports/schedule-time.ts`
- `server/src/modules/reports/schedule-time.test.ts`
- `db/migrations/7004_report_schedule_local_time.sql`
- `db/migrations/7005_report_delivery_outbox.sql`
- `db/migrations/7006_report_delivery_recipients.sql`
- `db/migrations/7007_website_slug_check.sql`
- `db/migrations/7008_phase14_fk_indexes_and_retention_scope.sql`
- `server/src/modules/exports/zip.ts`
- `server/src/modules/exports/zip.test.ts`
- `server/src/modules/exports/report-serializers.ts`
- `server/src/modules/exports/report-serializers.test.ts`
- `shared/src/reports/datasets.ts`
- `shared/src/reports/datasets.test.ts`
- `shared/src/schemas/reports.ts`
- `web/src/console/reports/ReportBuilder.tsx`
- `web/src/console/reports/ReportBuilder.test.tsx`
- `web/src/console/reports/routes.tsx`
- `web/src/console/reports/nav.ts`
- `web/src/console/reports/report.css`
- `shared/src/reports/datasets.ts`
- `shared/src/reports/datasets.test.ts`
- `web/src/console/reports/ReportBuilder.tsx`
- `web/src/marketing/Landing.tsx`
- `web/src/marketing/LegalPage.tsx`
- `web/src/marketing/LegalPage.test.tsx`
- `web/src/marketing/landing.css`
- `web/src/marketing/icons.tsx`
- `web/src/i18n/en/site.json`
- `web/src/i18n/es/site.json`
- `web/src/lib/i18n.ts`
- `web/src/lib/i18n-completeness.test.ts`
- `web/src/site/SitePage.tsx`
- `web/src/ui/routes.tsx`
- `web/src/ui/vite-env.d.ts`
- `server/src/integrations/email/templates/auth.tsx`
- `server/src/integrations/email/templates/auth.test.ts`
- `server/src/modules/website/public.ts`
- `server/src/modules/website/schema.ts`
- `server/src/modules/website/service.ts`
- `server/src/modules/website/routes.ts`
- `server/src/modules/website/module.ts`
- `server/src/modules/website/service.integration.test.ts`
- `web/src/console/website/WebsiteSettingsConsole.tsx`
- `web/src/console/website/WebsiteSettingsConsole.test.tsx`
- `web/src/console/website/WebsiteConsole.tsx`
- `web/src/console/website/routes.tsx`
- `web/src/console/website/website.css`
- `e2e/visual-reference/linux-baseline.sh`
- `web/src/marketing/PricingPage.tsx`
- `web/src/marketing/PricingPage.test.tsx`
- `vite.config.ts`
- `docs/qa/ACCESSIBILITY.md`
- `README.md`
- `shared/src/schemas/exports.ts`
- `server/src/modules/exports/service.ts`
- `server/src/modules/exports/routes.ts`
- `server/src/modules/exports/module.ts`
- `server/src/modules/exports/service.integration.test.ts`
- `web/src/console/home/OrganizationData.tsx`
- `web/src/console/home/OrganizationData.test.tsx`
- `web/src/console/Home.tsx`
- `web/src/console/home.css`

Exact next steps:
1. Add standard report presets and visual pages for receivables aging, compliance percentage, and year-over-year retention; registration pace and revenue by program presets already use source-backed grouped data.
2. Implement Action Center and Money, Registration, Compliance, and Academy dashboards, including board PDF output.
3. Finish website news, generated pages, domains, embeds, and public SSR wiring; settings and menus now have versioned APIs, an editor, and public navigation rendering.
4. Add privacy requests, retention policy UI, and retention sweep; export service and UI are implemented and awaiting generated route/worker registration.
5. Track C owns registry and nested-route wiring. Run Phase 14 acceptance and the SPRINT merge gate before marking ready or merging.
6. Complete Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README; merge through SPRINT's self-merge protocol when the gate is green.

Known failing or unverified checks:
- The owner-cited CI run `36337698479` at SHA `d038556` failed design parity on the 390px shell (7.51%) and missing Linux snapshots. That trunk revision did not contain D's Linux snapshot commit. A clean regeneration with the pinned Playwright 1.63 Noble image produces byte-identical showcase Linux snapshots; the focused Chromium parity suite passed 9/9 and the WebKit mobile screenshot test passed 1/1. Neither the 6.5% mismatch tolerance nor token-equality test changed.
- Focused report-builder UI test passed 1/1; report query validation passed 5/5, and focused report, schedule, export, ZIP, and shared-dataset checks passed 24/24. The grouped chart and table share the same server preview rows. `npm run typecheck` passes and the Track D reports path passes ESLint after the chart/preset additions.
- Website schema tests pass 3/3; after adding settings and menus, the website Postgres service suite passes 4/4 and the settings/menu UI test passes 1/1. Targeted Website ESLint and `npm run typecheck` pass. Settings and menus are tenant scoped, reject unsafe links, use optimistic versions, and keep their audit records free of link/email content.
- Phase 16 focused legal and i18n tests pass 3/3; the transactional-email translation coverage test passes 1/1 on the fresh verification database; marketing/website targeted ESLint and typecheck pass. `docs/qa/ACCESSIBILITY.md` documents the required 27 keyboard journeys; the manual pass has not been performed.
- The 15 visible report presets are backed by curated datasets and hide when the actor cannot access every referenced column. Aid awards stay money-role-only and Sensitive; uniform size counts omit participant identity; the aging bucket is derived from invoice balance and due date; payout amount retains the Sensitive tier.
- Current sync with `rebuild/trunk` passed typecheck, lint, an earlier full unit/integration run (898 passed, 1 skipped), focused website/report tests, Darwin parity (9/9), and a pinned Playwright 1.63 Noble Linux parity run. The latest report query/dataset/builder tests passed 15/15; merged fundraising/sponsors/report/website database tests passed 17/17. The latest clean Linux parity rerun passed Chromium 9/9, including the legacy 390px shell and every Linux snapshot; the selected WebKit mobile screenshot test passed 1/1. Running the entire parity file for both browser projects in the local Docker Desktop container still exhausts the container and kills Vite during WebKit axe checks; CI's issue is covered by the Chromium parity cases. The latest full suite attempt failed (45 failed, 298 passed, 557 skipped, 12 errors) after the isolated Postgres container entered WAL recovery and connections terminated; the Postgres log shows unclean shutdown recovery, not an OOM kill. Full Chromium desktop E2E had 32 passes, 6 skips, and one unrelated Track A photo-upload assertion failure at `e2e/people.spec.ts:102`; its error context showed no image element after upload. Build, full WebKit mobile E2E, knip, audit, and the SPRINT trunk merge gate remain open. Dashboards/action center, website news/domains/embeds/generated pages, export/privacy UI, and complete Phase 14 acceptance remain open.
- The first Playwright attempt found an orphaned Track D E2E runner on port 7173; that runner exited and the fresh isolated run passed.
- The org export integration test passes 2/2 against the fresh isolated Track D database; the Organization Data UI test passes 1/1. Focused export ESLint and typecheck pass. One first UI run failed because the project does not install jest-dom matchers; the assertion now uses standard `textContent`.

Open requests: Track A — investigate the photo upload E2E assertion in `e2e/people.spec.ts`; Track C — mount D's public website renderer at `/site` and wire Action Center/export routes and worker jobs. Generated Website/web registries and pricing API docs are committed on D. `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.
