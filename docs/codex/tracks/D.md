# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Design system queues 1–6 are complete. Linux parity baselines are generated and verified with the lockfile-matching Playwright Linux image. Phase 14 has report dataset listing, typed 200-row preview, saved-report sharing/versioning, audited restricted reads, and CSV/XLSX export foundations; schedules and the other Phase 14 surfaces plus Phase 16 remain.
Ready for integration: `195e30e..5cf711c` for the design-system and parity work only. Current HEAD also contains Phase 14 WIP and has not passed the SPRINT merge gate.
Requests to other tracks: Track C — include `server/src/modules/reports/module.ts` in the generated module registry and mount `/api/v1/reports`; later wire D's action-center, website, exports, and nested web feature routes/jobs as those module contracts land.
Blocked on: None.

Completed:
- Queue 1 legacy reference captures and token snapshot; queue 2 primitives published in early batches.
- Queue 3 extended controls, overlays, calendar views/resource grid, chart, rich text, signature, QR, print, keyboard-accessible board, bracket, and chat components.
- Queue 4 parity suite; queue 5 mobile bottom tabs, command palette, and global search shell; queue 6 shared auth controls.
- Linux parity references were generated using `mcr.microsoft.com/playwright:v1.63.0-noble` with `linux/amd64`. The 9-case design parity spec passed on both Mac and Linux; legacy references remain and the mismatch threshold and token-equality assertion are unchanged.
- Phase 14 base migrations 7000–7003, generated DB types, report dataset/query/schema/service/router/module, CSV/XLSX serializers, and ZIP helper are present. Migrations were applied to the isolated `athlentry_e2e` database.

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
- `server/src/modules/reports/schedule-time.ts`
- `server/src/modules/reports/schedule-time.test.ts`
- `db/migrations/7004_report_schedule_local_time.sql`
- `db/migrations/7005_report_delivery_outbox.sql`
- `server/src/modules/exports/zip.ts`
- `server/src/modules/exports/zip.test.ts`
- `server/src/modules/exports/report-serializers.ts`
- `server/src/modules/exports/report-serializers.test.ts`
- `shared/src/reports/datasets.ts`
- `shared/src/reports/datasets.test.ts`
- `shared/src/schemas/reports.ts`

Exact next steps:
1. Have Track C register and mount the D-owned report module; until then the API code is ready but unreachable through the app registry.
2. Fix the schedule lint/typecheck errors recorded in HANDOFF, add scheduled report delivery with recipient reauthorization, local-time cadence, Internal-only CSV attachments, and secure sign-in links; finish the report builder UI and standard reports.
3. Implement Action Center and the Money, Registration, Compliance, and Academy dashboards, including board PDF output.
4. Implement the website editor and public pages, SEO, domains, embeds, and SSR; then complete org export, privacy requests, and retention sweep.
5. Track C owns route/job registry and nested web route wiring. Run the Phase 14 acceptance checks and SPRINT merge gate before marking ready or merging.
6. At 13:00 local time, begin Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README. Continue small commits and use SPRINT's self-merge protocol only when the gate is green.

Known failing or unverified checks:
- No current Linux or Mac parity assertion failures are known; the focused parity suite passed 9/9 in each environment.
- Targeted report-query, report-service, CSV/XLSX, and ZIP checks last passed 16/16; shared dataset tests passed 3/3. Typecheck and targeted ESLint/Prettier passed before the schedule changes below.
- The commit hook's ESLint run failed with 14 errors in `server/src/modules/reports/module.ts`, `server/src/modules/reports/routes.ts`, `server/src/modules/reports/schedule-time.ts`, and `server/src/modules/reports/schedules.ts` (unsafe/error-typed schema use, an unnecessary number conversion, and an unused import).
- Schedule service, recurrence, routes, and migrations 7004–7005 are current WIP; focused schedule checks and typecheck have not been rerun after these edits.
- Full unit/integration, full E2E, build, registry/OpenAPI freshness, knip, audit, and the SPRINT merge gate have not been run against the current Phase 14 branch state. Phase 14 and Phase 16 acceptance remain unverified.
- The previous attempt to run Playwright with its default local server failed to bind because port 7173 was already occupied; the isolated parity config reused the running server and passed.

Open requests: Track C report module registry/mounting described above, followed by D feature route/job wiring as those contracts land. `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.

## HANDOFF

Done:
- Design system queues 1–6 and Linux/macOS design parity baselines are complete. The parity suite passed 9/9 in both environments; tolerance and token-equality assertions are unchanged.
- Phase 14 report foundations are implemented: dataset listing, typed and capped preview, saved report sharing/versioning, role/tier authorization, restricted-read audit, CSV/XLSX serialization, and report API routes/module metadata. Focused report tests last passed 16/16 and shared dataset tests 3/3 before schedule edits.
- Migrations 7000–7005 are present; 7004 and 7005 were applied to the isolated database and DB types were regenerated.

In progress (exact paths):
- `db/migrations/7004_report_schedule_local_time.sql`
- `db/migrations/7005_report_delivery_outbox.sql`
- `server/src/db/types.ts`
- `server/src/modules/reports/module.ts`
- `server/src/modules/reports/policy.ts`
- `server/src/modules/reports/routes.ts`
- `server/src/modules/reports/schedule-time.test.ts`
- `server/src/modules/reports/schedule-time.ts`
- `server/src/modules/reports/schedules.ts`
- `server/src/modules/reports/service.ts`
- `shared/src/schemas/reports.ts`

Exact next steps, in order:
1. Fix the lint and typecheck errors listed below; finish and verify schedule recurrence/CRUD in the paths above; implement durable outbox delivery with current recipient authorization, org-local cadence, idempotency, safe sign-in links, and Internal-only CSV attachments; register the schedule job contract in the report module.
2. Have Track C add `server/src/modules/reports/module.ts` to the generated registry and mount `/api/v1/reports`, then request the corresponding schedule job wiring.
3. Finish the report builder UI and standard reports; implement the Action Center and Money, Registration, Compliance, and Academy dashboards with action cards and board PDF output.
4. Implement website pages/news/menus/theme, auto-generated pages, SEO, subdomain/custom-domain flow, embeds, and SSR for `/site`; finish organization export, privacy requests, and the retention sweep.
5. Run affected tests, typecheck, lint, full Phase 14 acceptance and the SPRINT merge gate; update the integration range only after its gate passes.
6. At feature freeze, complete Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README truthfulness, then coordinate the gate with Track C.

Known failing tests or checks:
- No current parity failures are known; the Linux and macOS parity runs both passed.
- The commit hook's ESLint run failed with 14 errors in `server/src/modules/reports/module.ts`, `server/src/modules/reports/routes.ts`, `server/src/modules/reports/schedule-time.ts`, and `server/src/modules/reports/schedules.ts` (unsafe/error-typed schema use, an unnecessary number conversion, and an unused import).
- The commit hook's typecheck failed because `reportScheduleBodySchema` is declared twice in `shared/src/schemas/reports.ts` and `canEditSavedReport` is unused in `server/src/modules/reports/schedules.ts`.
- The previously passing focused report tests and typecheck predate schedule edits. Schedule tests/typecheck, full unit/integration, E2E, build, registry/OpenAPI freshness, knip, audit, and the Phase 14 merge gate remain unverified on this branch.
- A prior default Playwright run could not bind port 7173 because another local server occupied it; the isolated parity run passed using the running server.

Open requests:
- Track C: register and mount the report module at `/api/v1/reports`; later wire D-owned report schedule jobs and D feature routes as their module contracts land.

Environment: `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.

HANDED OFF 11:30
