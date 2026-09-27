# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Design system queues 1–6 are complete. Linux parity baselines are generated and pass in the lockfile-matching Playwright Linux image. Phase 14 report APIs and the report builder UI now support curated role-visible datasets, 200-row previews, typed filters, grouping/aggregates/sorting, saved-report role sharing, CSV/XLSX exports, and secure-link schedules with pause/resume. Action Center, visual standard reports/dashboards, website, org export, privacy, and retention surfaces remain.
Ready for integration: `195e30e..HEAD` is the intended local range after the SPRINT merge gate; the merge gate remains pending for the report-builder batch.
Requests to other tracks: Track C — run `npm run registry` to discover `server/src/modules/reports/module.ts` and `web/src/console/reports/routes.tsx`, then commit generated registry updates so `/api/v1/reports` and `/console/orgs/:orgId/reports` are reachable. As D contracts land, wire action-center, website, exports, and their worker jobs the same way.
Blocked on: None.

Completed:
- Queue 1 legacy reference captures and token snapshot; queue 2 primitives published in early batches.
- Queue 3 extended controls, overlays, calendar views/resource grid, chart, rich text, signature, QR, print, keyboard-accessible board, bracket, and chat components.
- Queue 4 parity suite; queue 5 mobile bottom tabs, command palette, and global search shell; queue 6 shared auth controls.
- Linux parity references were generated using `mcr.microsoft.com/playwright:v1.63.0-noble` with `linux/amd64`. The 9-case design parity spec passed on both Mac and Linux; legacy references remain and the mismatch threshold and token-equality assertion are unchanged.
- Phase 14 migrations 7000–7006, generated DB types, report dataset/query/schema/service/router/module, CSV/XLSX serializers, ZIP helper, org-local schedule CRUD, durable outbox delivery, and per-recipient outcomes are present. Migrations were applied to the isolated Track D database.

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
1. Have Track C register and mount the D-owned report module and schedule job; until then the API and worker contract are unreachable through the generated runtime registry.
2. Add saved-report presets and the required visual pages for registration pace, revenue by program, receivables aging, compliance percentage, and year-over-year retention.
3. Implement Action Center and the Money, Registration, Compliance, and Academy dashboards, including board PDF output.
4. Implement the website editor and public pages, SEO, domains, embeds, and SSR; then complete org export, privacy requests, and retention sweep.
5. Track C owns registry and nested-route wiring. Run the Phase 14 acceptance checks and SPRINT merge gate before marking ready or merging.
6. At 13:00 local time, begin Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README. Continue small commits and use SPRINT's self-merge protocol only when the gate is green.

Known failing or unverified checks:
- No current Linux or Mac parity assertion failures are known; the focused parity suite passed 9/9 in each environment.
- Focused report-builder UI test passed 1/1; focused report, schedule, export, ZIP, and shared-dataset checks passed 24/24. `npm run typecheck` passes and the Track D reports path passes ESLint after the new UI/test additions.
- Linux and macOS design parity tests each passed 9/9 on the D branch, but the Linux baseline commit is not yet in `rebuild/trunk`; trunk CI success remains unverified.
- Full unit/integration, full E2E, build, registry/OpenAPI freshness, knip, audit, and the SPRINT merge gate have not been run against the current Phase 14 branch state. Report builder, dashboards, website, exports/privacy UI, and Phase 16 acceptance remain unverified.
- The first Playwright attempt found an orphaned Track D E2E runner on port 7173; that runner exited and the fresh isolated run passed.

Open requests: Track C — register and mount `server/src/modules/reports/module.ts` at `/api/v1/reports`, including `reports.schedule-delivery`; later wire the action-center, website, exports, and nested web feature routes as their contracts land. `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.
