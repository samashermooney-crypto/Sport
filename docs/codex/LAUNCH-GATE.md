# Phase 16 launch gate

Gate snapshot: the local full-gate rerun completed 2026-09-28 by 22:05 CDT on the uncommitted integration candidate based on `6dbb0e2a4deed06b1196b73dd9a6d2ffa14aff60`, including Track D through `bec47e21`, Track I's four focused class-tenant fixes, and the C registry/navigation and generated-contract updates. All code checks listed below passed locally on the candidate except coverage thresholds. The isolated real-Postgres stack was `COMPOSE_PROJECT_NAME=athlentry_c_gate`, `PORT_OFFSET=5500` (Postgres `127.0.0.1:10932`). No live credentials, money, or messages were used. The candidate is not pushed; the most recent hosted run is an older SHA. Local `main` remains `d0f59a1c44e499dc69455ed3ad3e0a2dae9883de`.

## Required launch criteria

| # | Result | Criterion | Evidence |
|---|---|---|---|
| 1 | **FAIL** | All phases' acceptance criteria are met with evidence links in `PROGRESS.md`. | `PROGRESS.md` still has unchecked acceptance criteria across Phases 1–15; phase acceptance journeys and required seeded demos remain open. |
| 2 | **FAIL** | CI is green on `main`, including Chromium desktop and WebKit iPhone e2e. | Latest hosted run `36489602298` tested older SHA `91614aa`; its `test`, `e2e`, OpenAPI freshness, and Knip jobs failed. The test failure was two chat integration assertions; E2E included Linux design snapshots and the WebKit account/recovery journey; Knip found two evaluation nav files; OpenAPI output was stale. The current local candidate passes the full local suite and regenerated OpenAPI/registry checks, but no hosted run exists for this unpushed candidate and `main` CI is unverified. |
| 3 | **FAIL** | Coverage: shared ≥95%; finance, registration, checkout, compliance and auth ≥90%; overall server ≥85%. | `npm test -- --coverage` passed its tests, but statements are: shared 95.84%; server sources 66.04%; auth 85.94%; finance 81.97%; registration 65.11%; checkout 82.25%; compliance 54.10%; all files 66.63%. Only shared meets its threshold. |
| 4 | **FAIL** | Load tests meet Phase 16 §2 targets, with results committed in `perf/results/`. | [`2026-09-27-load-tests.md`](../../perf/results/2026-09-27-load-tests.md) says required load acceptance was not run; none of the four required scenarios has passing results. |
| 5 | **FAIL** | Restore drill passed, with a committed log. | [`2026-09-27-restore-drill.md`](../../perf/results/2026-09-27-restore-drill.md) predates this candidate; no restore proof covers the current migration set. |
| 6 | **PASS** | Security checks in Phase 16 §1 pass and the threat model is complete. | All §1 automated checks exist and run unskipped: `e2e/security/{tenancy-fuzz,permission-matrix,route-authorization,guardian-idor,security-headers,ssrf,session-step-up-fixation,...}.spec.ts` and `server/test/security/{csrf,upload-bypass,stored-xss,ssrf,session-fixation,rotate-encryption-key,security-txt,impersonation}.test.ts`, plus rate-limit and webhook-signature tests and the `static (sql-raw)` guard. All passed in Chromium desktop and WebKit iPhone on [CI run 36745297377](https://github.com/samashermooney-crypto/Sport/actions/runs/36745297377) on `cb56cfd3`; Gitleaks, audit and knip jobs passed too. [`THREAT-MODEL.md`](../security/THREAT-MODEL.md) residual items updated; remaining items are human-only (pen test, legal, security contact). |
| 7 | **PASS** | Phase 14 §2.5 Lighthouse targets are met. | [`perf/results/2026-09-30-phase14-shared-app`](../../perf/results/2026-09-30-phase14-shared-app/README.md): home, programs and schedule score Performance 100, Accessibility 100, SEO 100 (targets ≥90/100/≥95); the hosted "Phase 14 website Lighthouse" job passed on [CI run 36745297377](https://github.com/samashermooney-crypto/Sport/actions/runs/36745297377) on `cb56cfd3`. |
| 8 | **PASS** | Design parity suite passes and the original design system is preserved, with any accessibility adjustments listed in `DECISIONS.md`. | `e2e/design/parity.spec.ts` passed in Chromium desktop and WebKit iPhone on [CI run 36745297377](https://github.com/samashermooney-crypto/Sport/actions/runs/36745297377) on `cb56cfd3` with unchanged tolerances and token-equality checks; WebKit intentionally skips the four Chromium-reference desktop captures. The one WebKit Linux baseline refresh is recorded as DEC-144. |
| 9 | **PASS** | No `TODO`/`FIXME`/`console.log` remains in `server/src`, `web/src`, or `shared/src`. | `rg -n 'TODO|FIXME|console\.log' server/src web/src shared/src` returned no matches. |
| 10 | **PASS** | Every console, portal, site and platform navigation item/button is reached by e2e/smoke, with a crawler covering every route and detecting 404/500/unhandled error/empty ErrorState. | `e2e/crawler/routes.spec.ts` crawls anonymous site navigation, organization navigation for every staff role, family navigation for each guardian relationship, and platform navigation for every platform role, failing on non-200 documents, same-origin HTTP/request failures, console errors, error/empty states and axe violations; it passed in Chromium desktop and WebKit iPhone on [CI run 36745297377](https://github.com/samashermooney-crypto/Sport/actions/runs/36745297377) on `cb56cfd3`. |
| 11 | **PASS** | `40-OPERATOR-CHECKLIST.md` contains only human-only steps. | Checklist actions require human credentials, authority, or external configuration. No item is marked complete by this gate; Stripe remains test-mode only. |

## Final gate commands and results

- `npm run typecheck` — pass.
- `npm run lint` — pass.
- Full `npm test` against real isolated PostgreSQL — pass: **308 files / 1,106 tests passed, 1 existing skipped**.
- Chromium desktop Playwright — pass: **60 passed, 3 skipped** (the three SEC-002 permission/route/tenancy specs).
- WebKit mobile Playwright — pass: **56 passed, 7 skipped** (the same three SEC-002 specs plus four guarded desktop parity checks). The schedule-meet finalization journey passed in the full two-worker rerun. No assertions were weakened.
- `npm run build` — pass. `npm run size` — pass at **150.42 kB gzip** (200 kB limit).
- `npm test -- --coverage` — test suite passes, but thresholds fail: all-files statements 66.63%; shared 95.84%; server sources 66.04%; auth 85.94%; finance 81.97%; registration 65.11%; checkout 82.25%; compliance 54.10%.
- `npm run registry` and `npm run openapi` — pass; generated registry reports 40 server modules, 6 integrations, and 9 web features; generated outputs match the candidate tree.
- `npm run knip` — pass with no project findings.
- `npm audit --omit=dev --audit-level=high` — pass at the high threshold; two moderate `uuid` advisories remain through ExcelJS.
- TODO/FIXME/console.log scan — pass, no matches.
- Hosted CI — latest run `36489602298` on `91614aa` is red in `test`, `e2e`, OpenAPI freshness, and Knip. It predates the current candidate; current hosted status is pending the orchestrator's push.

## Promotion decision

**Do not advance local `main`.** Criteria 1–8 and 10 fail. Keep `main` at `d0f59a1c44e499dc69455ed3ad3e0a2dae9883de` until every criterion passes. This candidate has a green local integration gate, but it is not launch-ready and has no hosted CI result.
