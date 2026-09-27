# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Current: Design system queues 1–6 are complete. Linux parity baselines are generated and verified with the lockfile-matching Playwright Linux image. Phase 14 has report-query foundations and migrations in WIP commits; the remaining Phase 14 surfaces and Phase 16 assignments are not complete.
Ready for integration: `195e30e..5cf711c` for the design-system and parity work only. Current HEAD also contains Phase 14 WIP and has not passed the SPRINT merge gate.
Requests to other tracks: Track C — wire the routes/jobs for D's report, action-center, website, and exports modules and nested web features after D provides their module contracts.
Blocked on: None.

Completed:
- Queue 1 legacy reference captures and token snapshot; queue 2 primitives published in early batches.
- Queue 3 extended controls, overlays, calendar views/resource grid, chart, rich text, signature, QR, print, keyboard-accessible board, bracket, and chat components.
- Queue 4 parity suite; queue 5 mobile bottom tabs, command palette, and global search shell; queue 6 shared auth controls.
- Linux parity references were generated using `mcr.microsoft.com/playwright:v1.63.0-noble` with `linux/amd64`. The 9-case design parity spec passed on both Mac and Linux; legacy references remain and the mismatch threshold and token-equality assertion are unchanged.
- Phase 14 base migrations 7000–7003, generated DB types, report dataset/query/schema foundations, report policy helper, and ZIP helper/tests are committed as WIP. Migrations were applied to the isolated `athlentry_e2e` database.

In progress (exact paths):
- `db/migrations/7000_website_core.sql`
- `db/migrations/7001_reports.sql`
- `db/migrations/7002_exports_privacy.sql`
- `db/migrations/7003_export_token_fix.sql`
- `server/src/db/types.ts`
- `server/src/modules/reports/query.ts`
- `server/src/modules/reports/policy.ts`
- `server/src/modules/reports/query.test.ts`
- `server/src/modules/exports/zip.ts`
- `server/src/modules/exports/zip.test.ts`
- `shared/src/reports/datasets.ts`
- `shared/src/reports/datasets.test.ts`
- `shared/src/schemas/reports.ts`

Exact next steps:
1. Review WIP commits `ef8413a` and `a3a1c24`; rerun report/ZIP/dataset tests and the migration checks on the isolated stack.
2. Finish the report module APIs and UI: dataset listing, typed preview, saved reports/sharing, scheduled delivery, standard reports, and CSV/XLSX export. Keep export access tiered and step-up protected.
3. Implement Action Center and the Money, Registration, Compliance, and Academy dashboards, including board PDF output.
4. Implement the website editor and public pages, SEO, domains, embeds, and SSR; then complete org export, privacy requests, and retention sweep.
5. Ask Track C to wire the generated module route/job registry and nested web routes once their contracts are ready. Run the Phase 14 acceptance checks and SPRINT merge gate before marking ready or merging.
6. At 13:30 local time, begin Phase 16 §3 accessibility/i18n, §5 legal drafts, and §6 landing/README. Continue small commits and use SPRINT's self-merge protocol only when the gate is green.

Known failing or unverified checks:
- No current Linux or Mac parity assertion failures are known; the focused parity suite passed 9/9 in each environment.
- Targeted report-query and ZIP tests last passed 9/9; shared dataset tests passed 3/3. The latest commit hook also passed typecheck and staged ESLint/Prettier.
- Full unit/integration, full E2E, build, registry/OpenAPI freshness, knip, audit, and the SPRINT merge gate have not been run against the current Phase 14 branch state. Phase 14 and Phase 16 acceptance remain unverified.
- The previous attempt to run Playwright with its default local server failed to bind because port 7173 was already occupied; the isolated parity config reused the running server and passed.

Open requests: Track C route/job registry and nested web route wiring described above. `COMPOSE_PROJECT_NAME=athlentry_d_sprint`; `PORT_OFFSET=2000`.

## HANDOFF

The current branch is not merge-ready as a whole: Phase 14 is incomplete, the full SPRINT gate has not passed, and the current HEAD includes report/export WIP. Do not merge current HEAD until the successor completes and verifies Phase 14; the earlier design-system/parity cutoff is `195e30e..5cf711c`.

In-progress code is limited to the exact file paths listed above. No Phase 14 web surfaces or Phase 16 deliverables have been completed. Keep this file current as the queue advances; do not edit `docs/codex/PROGRESS.md`.

Local stack: `COMPOSE_PROJECT_NAME=athlentry_d_sprint`, `PORT_OFFSET=2000`.

HANDED OFF 10:44
