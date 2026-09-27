# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Design system queues 1–6 are complete. Linux parity references are generated in the pinned Playwright 1.63 Noble image and pass there; commit `5cf711c` is still missing from trunk. The report API and builder support curated role-visible datasets, 200-row previews, typed filters, grouping and aggregates, saved-report role sharing, CSV/XLSX exports, local-time schedules with pause/resume, and visual presets for registration pace and revenue by program. Website page editing, safe structured content, versioned revisions, public JSON/sitemap endpoints, and an SSR renderer are implemented. Action Center, remaining standard reports/dashboards, website domains/menus/news/embeds, org export, privacy UI, and retention sweep remain.
Ready for integration: `195e30e..HEAD` is the current local D range. Typecheck, lint, focused reports tests, website tests, and design parity pass on D; trunk integration awaits a clean shared trunk checkout and a passing full gate. Migration 7008 supplies the Phase 14 FK indexes and org-scoped retention run shape required by schema guards.
Requests to other tracks: Track C — mount `createSiteSsrRouter` from `server/src/modules/website/public.ts` at `/site`; the current `ServerModule.extraRouters` contract only supports `/api/v1/*`. Regenerate server and nested web registries for website and console website routes, and wire Action Center, exports, and their worker jobs as those contracts land. Reports routing is present in the generated registry on this branch.
Blocked on: None.

Completed:
- Queue 1 legacy reference captures and token snapshot; queue 2 primitives published in early batches.
- Queue 3 extended controls, overlays, calendar views/resource grid, chart, rich text, signature, QR, print, keyboard-accessible board, bracket, and chat components.
- Queue 4 parity suite; queue 5 mobile bottom tabs, command palette, and global search shell; queue 6 shared auth controls.
- Linux parity references were generated using `mcr.microsoft.com/playwright:v1.63.0-noble` with `linux/amd64`. The 9-case design parity spec passed on both Mac and Linux; legacy references remain and the mismatch threshold and token-equality assertion are unchanged.
- On the current synced branch, the host Chromium desktop parity run passed 9/9; the pinned Linux Chromium run passed 9/9, including the 390px legacy shell comparison. CI run `36337698479` failed on the prior trunk commit because Linux snapshot files were absent; the baseline comparison passed in the target Linux image after selecting the Linux capture.
- Phase 14 migrations 7000–7008, generated DB types, report dataset/query/schema/service/router/module, CSV/XLSX serializers, ZIP helper, org-local schedule CRUD, durable outbox delivery, and per-recipient outcomes are present. Migrations were applied to the isolated Track D database.
- Website foundation: role-checked page editing, optimistic versions and revision history, public published-page JSON, sitemap output, structured safe-content schemas, a console editor, public page surface, legacy site CSS port, and an SSR document renderer. Focused schema tests pass 3/3 and the Postgres service tests pass 2/2 on a fresh isolated stack.

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

Exact next steps:
1. Add standard report presets and visual pages for receivables aging, compliance percentage, and year-over-year retention; registration pace and revenue by program presets already use source-backed grouped data.
2. Implement Action Center and Money, Registration, Compliance, and Academy dashboards, including board PDF output.
3. Finish website settings, menus, news, generated pages, domains, embeds, and public SSR wiring.
4. Complete org data export, privacy requests, retention policy UI, and sweep job.
5. Track C owns registry and nested-route wiring. Run Phase 14 acceptance and the SPRINT merge gate before marking ready or merging.
6. Complete Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README; merge through SPRINT's self-merge protocol when the gate is green.

Known failing or unverified checks:
- No current Linux or Mac parity assertion failures are known; the focused parity suite passed 9/9 in each environment. Neither the 6.5% mismatch tolerance nor token-equality test changed.
- Focused report-builder UI test passed 1/1; report query validation passed 5/5, and focused report, schedule, export, ZIP, and shared-dataset checks passed 24/24. The grouped chart and table share the same server preview rows. `npm run typecheck` passes and the Track D reports path passes ESLint after the chart/preset additions.
- Website schema tests pass 3/3, the website Postgres page service test passes 2/2, targeted website ESLint passes, and `npm run typecheck` passes. The preexisting D database rejected the restored untracked 7007 file checksum, so website integration validation used a fresh isolated Postgres stack without changing the old database.
- The latest full trunk `npm test` attempt failed on the missing FK indexes and `retention_sweep_runs.org_id` nullability, now fixed by migration 7008. It also hit timeout failures in finance reconciliation, officials, and several `afterAll` hooks under concurrent machine load; rerun the full suite before integration.
- Full unit/integration, full E2E, build, registry/OpenAPI freshness, knip, audit, and the SPRINT merge gate have not been run against the current Phase 14 branch state. Report builder, dashboards, website, exports/privacy UI, and Phase 16 acceptance remain unverified.
- The first Playwright attempt found an orphaned Track D E2E runner on port 7173; that runner exited and the fresh isolated run passed.

Open requests: Track C — mount the D-owned public website renderer at `/site`; `ServerModule.extraRouters` currently accepts only `/api/v1/*`. Regenerate server and nested web registries for website and console website routes, then wire Action Center, export routes, and worker jobs as their contracts land. `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.
