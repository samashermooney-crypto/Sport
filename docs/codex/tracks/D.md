# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Design system queues 1–6 are complete. Linux parity baselines are generated and pass in the lockfile-matching Playwright Linux image. Phase 14 now includes curated report datasets, 200-row previews, saved-report sharing/versioning, CSV/XLSX exports, org-local schedule CRUD, durable delivery outbox, and current-permission rechecks before email; report builder UI and the other Phase 14 surfaces remain.
Ready for integration: `195e30e..5cf711c` for the design-system and parity work only. Current HEAD also contains Phase 14 WIP and has not passed the SPRINT merge gate.
Requests to other tracks: Track C — include `server/src/modules/reports/module.ts` in the generated module registry and mount `/api/v1/reports`; later wire D's action-center, website, exports, and nested web feature routes/jobs as those module contracts land.
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

Exact next steps:
1. Have Track C register and mount the D-owned report module and schedule job; until then the API and worker contract are unreachable through the generated runtime registry.
2. Finish the report builder UI and standard report presets, including the required visual pages for registration pace, revenue by program, receivables aging, compliance percentage, and year-over-year retention.
3. Implement Action Center and the Money, Registration, Compliance, and Academy dashboards, including board PDF output.
4. Implement the website editor and public pages, SEO, domains, embeds, and SSR; then complete org export, privacy requests, and retention sweep.
5. Track C owns registry and nested-route wiring. Run the Phase 14 acceptance checks and SPRINT merge gate before marking ready or merging.
6. At 13:00 local time, begin Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README. Continue small commits and use SPRINT's self-merge protocol only when the gate is green.

Known failing or unverified checks:
- No current Linux or Mac parity assertion failures are known; the focused parity suite passed 9/9 in each environment.
- Focused report, schedule, export, ZIP, and shared-dataset checks passed 24/24. Full `npm run typecheck` and `npm run lint` pass on the current worktree.
- Linux and macOS design parity tests each passed 9/9 on the D branch, but the Linux baseline commit is not yet in `rebuild/trunk`; trunk CI success remains unverified.
- Full unit/integration, full E2E, build, registry/OpenAPI freshness, knip, audit, and the SPRINT merge gate have not been run against the current Phase 14 branch state. Report builder, dashboards, website, exports/privacy UI, and Phase 16 acceptance remain unverified.
- The previous attempt to run Playwright with its default local server failed to bind because port 7173 was already occupied; the isolated parity config reused the running server and passed.

Open requests: Track C — register and mount `server/src/modules/reports/module.ts` at `/api/v1/reports`, including `reports.schedule-delivery`; later wire the action-center, website, exports, and nested web feature routes as their contracts land. `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.
