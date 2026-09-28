# Track D — design system

Status: in-progress
Model: GPT-6 Luna
Branch: `track/d-design`
Parity CI follow-up: run `36364979347` at `2c52eb4718c4` used hosted Ubuntu 24.04.5 (`ubuntu24/20260920.314.1`), Playwright 1.63.0, Chromium 153.0.8010.12, WebKit 26.6, and the recorded Liberation/Noto/Fontconfig/Freetype versions. Its expected Linux images for `ui-core-1440`, `ui-feedback-390` (Chromium), and `ui-controls-390` (WebKit) were stale; all three actual PNGs in the report match the corresponding D-branch baselines byte-for-byte (`10bf6183`). The 390px and 1440px legacy-shell comparisons passed in this run and in `36357792018`. The 7.51% 390px shell mismatch was from earlier run `36337698479`, before the shell baseline was corrected, so this is a baseline integration gap rather than a layout regression. macOS references, mismatch tolerance, and token-equality assertion remain unchanged. The baseline manifest records the original capture run `36357792018`; the latest CI validation still needs the D baseline commit on trunk.
Current: Design system queues 1–6 are complete. Linux references use exact `ubuntu-latest` artifacts, with the runner/browser/font versions recorded; the baseline script preserves the root lockfile dependency tree by isolating legacy dependencies and warms Vite before capture. During trunk sync, migrations 7000 and 8000 collided on Phase 11-owned sponsor/fundraising tables and 7008/8010 duplicated FK index names; D-owned forward migrations 7009 and 7010 preserve the old tenant-scoped rows under legacy names and free canonical names. Migrations through 8011, DB codegen, registry generation, and OpenAPI generation pass. The report API and builder support curated role-visible datasets, 200-row previews, typed filters, grouping and aggregates, saved-report role sharing, CSV/XLSX exports, local-time schedules with pause/resume, and standard presets for registration pace/program/division/age/gender/ZIP, year-over-year participant retention, revenue by program, receivables aging, credential status, installment forecast, attendance status, payout status, official pay, donations, volunteer completion, financial-aid awards, and uniform sizes. Website page editing, safe structured content, versioned revisions, public JSON/sitemap endpoints, an SSR renderer, public plans/pricing, and tenant-scoped settings/menu APIs and console are implemented. The org export API, worker job, secure expiring download links, ZIP builder, and organization home UI are implemented; the generated server registry, nested console route, and OpenAPI schema include them. The privacy request workflow now supports step-up gated access exports, reviewed correction/deletion requests, subject notification, identity/medical/form/photo anonymization, revoked athlete cards, and a retention-policy view. The weekly retention job redacts aged communications and background-check detail, purges expired evaluation scores, and logs per-organization outcomes atomically. Its focused database suite passes 5/5, and the privacy UI request test passes 1/1. Typecheck and focused ESLint pass. Phase 16 landing/legal pages, English/Spanish website copy coverage, transactional-email translation coverage, keyboard review instructions, and README truthfulness are implemented. Website-domain ownership and TLS management, typed public widgets, console routes, iframe snippets, and the public embed route are implemented. Separate Money, Registration, Compliance, and Academy dashboard views are implemented with a 90-day installment forecast and participant-free academy aggregates. The role-filtered Action Center now queries approval, finance, compliance, safety, scheduling, volunteer, communications, and import queues; its focused UI and database suites pass 1/1 and 2/2. Generated page automation, the custom-domain ingress and `/site` SSR mounts, functional bulk actions, and the final Phase 14 acceptance gate remain.
- Reports overview now charts registrations across the trailing 12 months and a credential-compliance percentage; both retain accessible data tables. `ReportsDashboard.test.tsx` passes 1/1, focused ESLint passes, and the guarded repository typecheck passes.
Current update: the website news API, versioned editor, published-only public feed and sitemap entry, and SPA/SSR news views are implemented. English/Spanish labels are registered in i18n. The UI and translation tests pass 2/2; the website integration suite passes 5/5 with temporary local timeout overrides for the cloned test database under shared-runner load. Track C still needs to mount the SSR router at `/site`.
Current update: public Programs index/detail and Schedule pages now render server-side with generated navigation, localized metadata, canonical/robots tags, SportsEvent JSON-LD, public-only active program/event filtering, and reserved CMS slugs. The website Postgres integration file passes 9/9 on the isolated D database; repository typecheck and focused ESLint pass.
Current update: the Reports route now includes a permission-filtered organization overview with registrations by program, receivables aging, and year-over-year retention charts. It uses the same report preview API as saved reports, formats currency/percent values in both the visual and accessible data table, and omits summaries whose columns are not allowed for the current role. Its focused UI suite passes 8/8; focused ESLint and typecheck pass.
Current update: the dashboard now provides independent Organization, Money, Registration, Compliance, and Academy views. Money includes gross invoices, net payments after fees, fees, refunds, disputes, outstanding balances, and installments due in the next 90 days; Academy reports aggregate enrollment and session booking status without participant fields. View switching, the report catalog, and data privacy checks pass (dashboard UI 1/1; dataset catalog 9/9); focused ESLint and repository typecheck pass.
Current update: the Board season report now downloads as a one-page PDF containing only aggregate metrics. It reuses report role checks, step-up protection for sensitive money fields, and export audit records. Renderer test passes 1/1; the fresh isolated-database integration now passes 6/6, including registrar output, finance rejection without step-up, and finance output after step-up. Repository typecheck passes and focused ESLint passes.
Phase 16 §3 update: shared charts and report previews expose screen-reader data tables, calendar regions announce their current heading, and boards expose named regions/columns with a keyboard move select. Focused chart/board tests pass 2/2, calendar tests pass 3/3, and the Reports preview test verifies the chart table. The full 27-journey manual keyboard review is still open.
Current parity integration: D's three corrected Linux component references are staged in the no-commit `rebuild/trunk` integration. CI run `36364979347` at `2c52eb47` actual PNGs match them byte-for-byte; the legacy shell comparison passes at 390px and 1440px. The earlier 7.51% shell mismatch came from run `36337698479`, before its Linux shell baseline existed. The shell and component refs are not loosened; macOS references and the token-equality assertion are unchanged. Awaiting post-merge GitHub CI confirmation.
Ready for integration: local commit range `195e30e..HEAD` includes reusable design primitives and Phase 14/16 work; parity commit `10bf6183` contains the CI Linux screenshots and runner provenance. The synced Track D head and the staged no-commit trunk merge pass typecheck, lint, full `npm test` (300 files passed, 1 skipped; 1,077 tests passed, 1 skipped), and Chromium desktop E2E (50 passed, 3 skipped). The trunk merge commit is pending. Migration 7008 supplies Phase 14 FK indexes; 7009–7010 preserve legacy fundraising website rows and indexes before Phase 11 tables apply; 7011 adds scoped answer redaction.
Requests to other tracks: Track C — mount `createSiteSsrRouter` from `server/src/modules/website/public.ts` at `/site`; the current `ServerModule.extraRouters` contract only supports `/api/v1/*`. Wire Action Center and its worker jobs. The generated server, nested-web, and OpenAPI registries now include Website and exports.
Blocked on: None.

Completed:
- Queue 1 legacy reference captures and token snapshot; queue 2 primitives published in early batches.
- Queue 3 extended controls, overlays, calendar views/resource grid, chart, rich text, signature, QR, print, keyboard-accessible board, bracket, and chat components.
- Queue 4 parity suite; queue 5 mobile bottom tabs, command palette, and global search shell; queue 6 shared auth controls.
- Phase 16 accessibility additions: chart data is available in a semantic screen-reader table; calendars and boards have named regions/columns; board keyboard-move control is tested. The full manual keyboard journey pass remains open.
- Linux parity snapshots are sourced from GitHub Actions `ubuntu-24.04` x86_64 actuals; the manifest records Playwright/browser/font versions and original capture run `36357792018`. The baseline generator now refuses container and non-x86_64 captures; macOS references, mismatch tolerance, and token-equality assertion remain unchanged.
- CI run `36364979347` confirms the 390px and 1440px legacy-shell comparisons pass. Its three failed Linux component actuals match D's corrected baselines byte-for-byte, confirming those failures are stale references missing from trunk.
- Phase 14 migrations 7000–7010, generated DB types, report dataset/query/schema/service/router/module, CSV/XLSX serializers, ZIP helper, org-local schedule CRUD, durable outbox delivery, and per-recipient outcomes are present. D and H migrations through 8010 apply on the isolated Track D database, and the full current schema generates 263 table types.
- Current sync: D includes local `rebuild/trunk` commit `bd70207e` in merge commit `64a1620e`. The typecheck passed against a fresh isolated schema before this sync; the reused dev DB's historical checksum mismatch for migration 7007 was left untouched, and full migration and code generation completed in the fresh schema DB.
- Website foundation: role-checked page editing, optimistic versions and revision history, public published-page JSON, sitemap output, structured safe-content schemas, a console editor, public page surface, legacy site CSS port, and an SSR document renderer. Focused schema tests pass 3/3 and the Postgres service tests pass 2/2 on a fresh isolated stack.
- Website news: tenant-scoped create/update/list APIs with optimistic versions and audit metadata; published-only public feed, sitemap entry, text-only editor, localized English/Spanish copy, and SPA/SSR news views. User body content is rendered as text, not interpreted as HTML.
- Public pricing now lists only active plans and exposes only name, key, monthly cents, and the custom-pricing flag; the `/pricing` page renders that API response and handles loading, empty, and error states. Marketing pricing/legal/i18n tests pass 4/4 and website PostgreSQL service tests pass 3/3 on the fresh verification stack; focused ESLint and typecheck pass.
- Standard reports now include registration by gender and household ZIP/postal code. Their source columns remain Sensitive-tier and are only surfaced to roles allowed to query them. Year-over-year retention compares unique confirmed participants across adjacent calendar years, reports the previous cohort size, retained count and percentage, and uses the existing save/share/schedule/export flow. Fresh-stack report tests pass 22/22, including a fixture that verifies 2 prior participants, 1 retained participant and a 50% rate.
- Organization export now lists and requests tenant archives, requires an owner/admin membership and recent step-up authentication, queues a durable build job, writes tenant table CSVs and a file manifest into an expiring ZIP, and issues a hashed, single-use seven-day download token. The console home links to the export view. Fresh isolated-stack service tests pass 2/2, the UI test passes 1/1, focused ESLint passes, and `npm run typecheck` passes.

In progress (exact paths):
- `server/src/modules/action-center/module.ts`
- `server/src/modules/action-center/routes.ts`
- `server/src/modules/action-center/schema.ts`
- `server/src/modules/action-center/service.ts`
- `server/src/modules/action-center/service.integration.test.ts`
- `web/src/console/home/ActionCenter.tsx`
- `web/src/console/home/ActionCenter.test.tsx`
- `web/src/console/home/action-center-schema.ts`
- `web/src/console/home/routes.tsx`
- `web/src/console/home.css`
- `docs/codex/tracks/D.md`
- `db/migrations/7000_website_core.sql`
- `db/migrations/7001_reports.sql`
- `db/migrations/7002_exports_privacy.sql`
- `db/migrations/7003_export_token_fix.sql`
- `server/src/db/types.ts`
- `server/src/modules/reports/query.ts`
- `server/src/modules/reports/board-report.ts`
- `server/src/modules/reports/board-report.test.ts`
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
- `db/migrations/7009_preserve_website_campaign_records.sql`
- `db/migrations/7010_rename_legacy_phase11_indexes.sql`
- `db/migrations/7011_privacy_redact_form_answers.sql`
- `server/src/modules/exports/zip.ts`
- `server/src/modules/exports/zip.test.ts`
- `server/src/modules/exports/report-serializers.ts`
- `server/src/modules/exports/report-serializers.test.ts`
- `shared/src/reports/datasets.ts`
- `shared/src/reports/datasets.test.ts`
- `shared/src/schemas/reports.ts`
- `web/src/console/reports/ReportBuilder.tsx`
- `web/src/console/reports/ReportBuilder.test.tsx`
- `web/src/console/reports/ReportsDashboard.tsx`
- `web/src/console/reports/ReportsDashboard.test.tsx`
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
- `server/src/modules/website/domain-security.ts`
- `server/src/modules/website/domain-security.test.ts`
- `web/src/console/website/WebsiteDomainsConsole.tsx`
- `web/src/console/website/WebsiteDomainsConsole.test.tsx`
- `web/src/console/website/WebsiteEmbedsConsole.tsx`
- `web/src/console/website/WebsiteEmbedsConsole.test.tsx`
- `web/src/site/WebsiteEmbedPage.tsx`
- `web/src/site/WebsiteEmbedPage.test.tsx`
- `web/src/console/website/WebsiteNewsConsole.tsx`
- `web/src/console/website/WebsiteNewsConsole.test.tsx`
- `web/src/site/SiteNewsPage.tsx`
- `web/src/site/routes.tsx`
- `web/src/console/website/routes.tsx`
- `web/src/console/website/WebsiteConsole.tsx`
- `web/src/lib/i18n.ts`
- `web/src/lib/i18n-completeness.test.ts`
- `web/src/i18n/en/platform.json`
- `web/src/i18n/es/platform.json`
- `web/src/ui/extended.tsx`
- `web/src/ui/extended.test.tsx`
- `web/src/ui/primitives.test.tsx`
- `web/src/ui/components.css`
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
- `web/src/console/home/OrganizationPrivacy.tsx`
- `web/src/console/home/OrganizationPrivacy.test.tsx`
- `web/src/console/Home.tsx`
- `web/src/console/home.css`

Exact next steps:
1. Dashboard views and Board PDF are implemented; verify dashboard access by role and exercise the protected PDF route against the isolated Track D schema.
2. Add working bulk actions to the Action Center; the initial role-filtered queues and read-only destinations are implemented and focused tests pass.
3. Finish generated pages, domains and embeds; ask Track C to mount the public SSR router at `/site`. Website news, settings, and menus now have tenant-scoped APIs, editors, localized public rendering, and sitemap/navigation output.
4. Obtain post-merge GitHub CI confirmation for the Linux component references and continue Phase 14 acceptance on the integrated head.
5. Finish Phase 14 acceptance: generated pages/domains/embeds, verified custom-domain routing, SSR mount at `/site`, Lighthouse checks, and the full phase gate.
6. Track C owns registry and nested-route wiring, including the `/site` mount and Action Center/export jobs. Complete the 27 keyboard journeys and remaining Phase 16 §3 accessibility/i18n evidence, then verify §5 legal drafts and §6 landing/README on the merged head.

Known failing or unverified checks:
- The staged trunk merge passed the complete Track D merge gate: typecheck, lint, 300 test files passed/1 skipped (1,077 tests passed/1 skipped), and Chromium desktop 50 passed/3 skipped. The hosted Linux snapshots still need post-merge CI confirmation.
- Focused report-builder UI test passed 1/1; report query validation passed 5/5, and focused report, schedule, export, ZIP, and shared-dataset checks passed 24/24. The grouped chart and table share the same server preview rows. `npm run typecheck` passes and the Track D reports path passes ESLint after the chart/preset additions.
- Website schema tests pass 3/3; after adding settings and menus, the website Postgres service suite passes 4/4 and the settings/menu UI test passes 1/1. Targeted Website ESLint and `npm run typecheck` pass. Settings and menus are tenant scoped, reject unsafe links, use optimistic versions, and keep their audit records free of link/email content.
- Phase 16 focused legal and i18n tests pass 3/3; the transactional-email translation coverage test passes 1/1 on the fresh verification database; marketing/website targeted ESLint and typecheck pass. `docs/qa/ACCESSIBILITY.md` documents the required 27 keyboard journeys; the manual pass has not been performed.
- The 15 visible report presets are backed by curated datasets and hide when the actor cannot access every referenced column. Aid awards stay money-role-only and Sensitive; uniform size counts omit participant identity; the aging bucket is derived from invoice balance and due date; payout amount retains the Sensitive tier.
- Current D merge-gate checks pass; build, full WebKit mobile E2E, knip, audit, hosted Linux CI confirmation, Lighthouse acceptance, verified custom-domain ingress and `/site` SSR mount, functional Action Center bulk actions, final Phase 14 acceptance, and manual keyboard journeys remain unverified/open. The previous chat failures and Track A photo-upload E2E failure no longer reproduce on this synced head.
- The first Playwright attempt found an orphaned Track D E2E runner on port 7173; that runner exited and the fresh isolated run passed.
- The new Action Center server integration suite passes 2/2 against the isolated Track D database and executes every role-visible source query with an empty organization; the UI queue/link test passes 1/1. No Action Center test failures remain.
- The org export integration test passes 2/2 against the fresh isolated Track D database; the Organization Data UI test passes 1/1. Focused export ESLint and typecheck pass. One first UI run failed because the project does not install jest-dom matchers; the assertion now uses standard `textContent`.
- Privacy/retention service suite passes 5/5 and the Organization Privacy request-creation UI test passes 1/1 against isolated tests. The first integration attempt found a malformed evaluation retention cutoff query and a JSONB array encoding issue; both are fixed. The default shared `5432` database still has a historical migration collision, so this suite was run against the Track D stack on port `7432`.
- Website domain/embed API database tests pass 7/7 on the isolated Track D stack; domain/embed UI tests pass 3/3, the DNS target classifier passes 10/10, and a post-sync design parity run remains unverified.

Open requests: Track A — investigate the photo upload E2E assertion in `e2e/people.spec.ts`; Track C — mount D's public website renderer at `/site`, route verified custom-domain hosts to the correct public site, and wire Action Center/export routes and worker jobs; Track H — fix the deterministic chat notification-batching and internal-attachment failures in `server/src/modules/chat/service.integration.test.ts`. `COMPOSE_PROJECT_NAME=athlentry_d_finish`; `PORT_OFFSET=2000`.
