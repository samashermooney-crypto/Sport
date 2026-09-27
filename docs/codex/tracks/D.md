# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Design system queues 1–6 are complete. Linux parity references and platform-specific shell lookup are on D in commit `5cf711c`; the pinned Playwright 1.63 Noble run passes all 9 parity cases, including the 390px comparison, with one worker. The reported 7.51% delta came from comparing a Linux render with the Darwin baseline; the shell passes against its Linux reference, so it is not a layout regression. During trunk sync, migrations 7000 and 8000 collided on Phase 11-owned sponsor/fundraising tables and 7008/8010 duplicated FK index names; D-owned forward migrations 7009 and 7010 preserve the old tenant-scoped rows under legacy names and free canonical names. Migrations through 8010, DB codegen, registry generation, and OpenAPI generation now pass. The report API and builder support curated role-visible datasets, 200-row previews, typed filters, grouping and aggregates, saved-report role sharing, CSV/XLSX exports, local-time schedules with pause/resume, and standard presets for registration pace/program/division/age group, revenue by program, receivables aging, credential status, installment forecast, attendance status, payout status, official pay, and donations. Website page editing, safe structured content, versioned revisions, public JSON/sitemap endpoints, an SSR renderer, and a public plan catalog/pricing page are implemented. Phase 16 landing/legal pages, English/Spanish website copy coverage, transactional-email translation coverage, keyboard review instructions, and README truthfulness are implemented. Action Center, remaining standard reports/dashboards, website domains/menus/news/embeds, org export, privacy workflow, and retention sweep remain.
Ready for integration: `195e30e..HEAD` is the current local D range. Typecheck and lint pass; the focused report/website/fundraising/sponsor database suite passes 17/17. The exact trunk merge gate is pending. Migration 7008 supplies Phase 14 FK indexes; 7009–7010 preserve its legacy fundraising website rows and indexes before Phase 11 tables apply.
Requests to other tracks: Track A — investigate `e2e/people.spec.ts` image upload assertion (the edited profile shows no image after upload); this is outside D ownership and currently fails the full desktop E2E gate. Track C — mount `createSiteSsrRouter` from `server/src/modules/website/public.ts` at `/site`; the current `ServerModule.extraRouters` contract only supports `/api/v1/*`. Wire Action Center and export routes with their worker jobs. The D branch now includes regenerated server, nested web, and OpenAPI registries for Website and its pricing endpoint.
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
- Standard reports now include registration by program and age group, payout amounts by settlement status, official pay by official, and donations by campaign. Payouts are restricted to money-report roles and the amount column retains the Sensitive tier; report query tests pass 7/7 and the builder UI test passes 1/1.

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
- `web/src/marketing/PricingPage.tsx`
- `web/src/marketing/PricingPage.test.tsx`
- `vite.config.ts`
- `docs/qa/ACCESSIBILITY.md`
- `README.md`

Exact next steps:
1. Add standard report presets and visual pages for receivables aging, compliance percentage, and year-over-year retention; registration pace and revenue by program presets already use source-backed grouped data.
2. Implement Action Center and Money, Registration, Compliance, and Academy dashboards, including board PDF output.
3. Finish website settings, menus, news, generated pages, domains, embeds, and public SSR wiring.
4. Complete org data export, privacy requests, retention policy UI, and sweep job.
5. Track C owns registry and nested-route wiring. Run Phase 14 acceptance and the SPRINT merge gate before marking ready or merging.
6. Complete Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README; merge through SPRINT's self-merge protocol when the gate is green.

Known failing or unverified checks:
- The owner-cited CI run `36337698479` at SHA `d038556` failed four e2e tests, including the 390px shell comparison (7.51%) and missing Linux snapshots. That revision had no `*-linux.png` parity references or platform-specific legacy capture selection. The D parity suite passed 9/9 on Mac and 9/9 inside Playwright 1.63 Noble after the Linux references were added. Neither the 6.5% mismatch tolerance nor token-equality test changed.
- Focused report-builder UI test passed 1/1; report query validation passed 5/5, and focused report, schedule, export, ZIP, and shared-dataset checks passed 24/24. The grouped chart and table share the same server preview rows. `npm run typecheck` passes and the Track D reports path passes ESLint after the chart/preset additions.
- Website schema tests pass 3/3, website Postgres service tests pass 3/3, targeted website/marketing ESLint passes, and `npm run typecheck` passes. The preexisting D database rejected the restored untracked 7007 file checksum, so website integration validation used a fresh isolated Postgres stack without changing the old database.
- Phase 16 focused legal and i18n tests pass 3/3; the transactional-email translation coverage test passes 1/1 on the fresh verification database; marketing/website targeted ESLint and typecheck pass. `docs/qa/ACCESSIBILITY.md` documents the required 27 keyboard journeys; the manual pass has not been performed.
- The 12 visible report presets are backed by curated datasets and hide when the actor cannot access every referenced column. The aging bucket is derived from invoice balance and due date; payout amount retains the Sensitive tier.
- Current sync with `rebuild/trunk` passed typecheck, lint, an earlier full unit/integration run (898 passed, 1 skipped), focused website/report tests (20 passed), Darwin parity (9/9), and pinned Playwright 1.63 Noble Linux parity (9/9 with one worker). The latest full suite attempt failed (45 failed, 298 passed, 557 skipped, 12 errors) after the isolated Postgres container entered WAL recovery and connections terminated; the Postgres log shows unclean shutdown recovery, not an OOM kill. The focused report role test (7/7) and pricing/report-builder UI tests (2/2) pass after recovery. Full Chromium desktop E2E had 32 passes, 6 skips, and one unrelated Track A photo-upload assertion failure at `e2e/people.spec.ts:102`; its error context showed no image element after upload. The first five-worker Linux retry hit Chromium process crashes on machine load; the controlled run passed. Build, WebKit mobile E2E, knip, audit, and the SPRINT trunk merge gate remain open. Dashboards/action center, full website workflows, export/privacy UI, and complete Phase 14 acceptance remain open.
- The first Playwright attempt found an orphaned Track D E2E runner on port 7173; that runner exited and the fresh isolated run passed.

Open requests: Track A — investigate the photo upload E2E assertion in `e2e/people.spec.ts`; Track C — mount D's public website renderer at `/site` and wire Action Center/export routes and worker jobs. Generated Website/web registries and pricing API docs are committed on D. `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.
