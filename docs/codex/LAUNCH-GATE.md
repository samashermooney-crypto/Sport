# Phase 16 launch gate

Gate snapshot: `rebuild/trunk` code at `da7c13f40717352ff6b550b7b5026dd6d1e62f94` (2026-09-27 local run). The repository was clean before recording these docs. All commands were run locally through `~/athlentry-sprint/heavy.sh` where applicable, against the isolated Postgres stack `COMPOSE_PROJECT_NAME=athlentry_c PORT_OFFSET=510` (Postgres host port 5942). No live credentials, live money, or real messages were used. GitHub status could not be queried because this environment has no network. Local `main` remains `d0f59a1c44e499dc69455ed3ad3e0a2dae9883de`.

## Required launch criteria

| # | Result | Criterion | Evidence |
|---|---|---|---|
| 1 | **FAIL** | All phases’ acceptance criteria are met with evidence links in `PROGRESS.md`. | The phase table and detailed acceptance checklists in [`PROGRESS.md`](PROGRESS.md) retain unchecked criteria across Phases 1–13; Phases 14–15 are not started. Phase 16 has incomplete security/load/restore/accessibility evidence. |
| 2 | **FAIL** | CI is green on `main`, including Chromium desktop and WebKit iPhone e2e. | Local Playwright passes below, but network access prevented checking GitHub CI and `main` is still `d0f59a1…`, behind the gated `rebuild/trunk` snapshot. Local checks cannot establish this CI requirement. |
| 3 | **FAIL** | Coverage: shared ≥95%; finance, registration, checkout, compliance and auth ≥90%; overall server ≥85%. | Full Vitest coverage output parsed from `coverage/coverage-final.json`: shared 96.07% (2175/2264); server overall 65.21% (13576/20818); finance 84.08% (3100/3687); registration 0 instrumented files; checkout 84.36% (410/486); compliance 55.04% (524/952); auth 87.12% (609/699). Server and all listed modules except shared miss their thresholds. |
| 4 | **FAIL** | Load tests meet Phase 16 §2 targets, with results committed in `perf/results/`. | [`perf/results/2026-09-27-load-tests.md`](../../perf/results/2026-09-27-load-tests.md) says acceptance was not run because the required load seed/contracts are unavailable; the four required scenarios have no passing results. |
| 5 | **FAIL** | Restore drill passed, with a committed log. | [`perf/results/2026-09-27-restore-drill.md`](../../perf/results/2026-09-27-restore-drill.md) records a successful older drill only through migration 6002. Current trunk contains migrations through 8010, so there is no restore proof for this snapshot. |
| 6 | **FAIL** | Security checks in Phase 16 §1 pass and the threat model is complete. | Security documentation exists, but required security acceptance is open. The browser run reports six `test.fixme` security cases skipped: `gitleaks-ci.spec.ts`, `permission-matrix.spec.ts`, `route-authorization.spec.ts`, `session-step-up-fixation.spec.ts`, `ssrf.spec.ts`, and `tenancy-fuzz.spec.ts`. `SEC-CI-001` (Gitleaks CI) and `SEC-SSRF-C-001` (Web Push destination validation) remain open in `tracks/C.md`; session fixation and route/permission coverage also remain unresolved. |
| 7 | **FAIL** | Phase 14 §2.5 Lighthouse targets are met. | No Lighthouse result is committed; `docs/codex/tracks/D.md` states Phase 14 has not started. |
| 8 | **PASS** | Design parity suite passes and the original design system is preserved, with any accessibility adjustments listed in `DECISIONS.md`. | `heavy.sh npm run test:e2e -- --workers=3`: 74 passed, 16 skipped across Chromium desktop and WebKit mobile; parity checks in the run pass. The Linux parity baseline also passed on the code-identical snapshot `9381acd`; the only code change after it is this final-gate documentation. `web/src/ui/tokens.test.ts` checks token equality and passed in the full Vitest run. |
| 9 | **PASS** | No `TODO`/`FIXME`/`console.log` remains in `server/src`, `web/src`, or `shared/src`. | `rg -n 'TODO|FIXME|console\.log' server/src web/src shared/src` returned no matches. |
| 10 | **FAIL** | Every console, portal, site and platform navigation item/button is reached by e2e/smoke, with a crawler covering every route and detecting 404/500/unhandled error/empty ErrorState. | No route-crawler implementation or result exists (`rg` search across `e2e` and docs found none). Current journeys cover important flows but do not establish all-route/all-button coverage. |
| 11 | **PASS** | `40-OPERATOR-CHECKLIST.md` contains only human-only steps. | Reviewed the full checklist. Its Stripe smoke step is explicitly limited to Stripe test mode and test cards; all remaining tasks require operator credentials, external approvals, legal/financial judgment, production infrastructure or human operational work. |

## Local gate commands and results

- `heavy.sh npm run typecheck` — pass.
- `heavy.sh npm run lint` — pass.
- `heavy.sh npm test -- --coverage --maxWorkers=4` — pass: 246 files passed, 1 skipped; 879 tests passed, 1 skipped. Coverage thresholds still fail as shown above.
- `heavy.sh npm run test:e2e -- --workers=3` — pass: 74 passed, 16 skipped. Chromium-only design assertions are intentionally skipped in WebKit; six security cases are `test.fixme` skips, which remain launch blockers.
- `heavy.sh npm run build` — pass.
- `heavy.sh npm run size` — pass: 143.71 kB gzip, below 200 kB.
- `heavy.sh npm run knip` — pass.
- `heavy.sh npm audit --omit=dev --audit-level=high` — pass; two moderate `uuid` advisories remain below the requested high threshold.
- `heavy.sh npm run openapi` plus `git diff --exit-code -- docs/api/openapi.json` — pass, generated OpenAPI current.
- `heavy.sh npm run registry` plus generated server/web registry, nested-route, shared-error and permission diff checks — pass.
- `rg -n 'TODO|FIXME|console\.log' server/src web/src shared/src` — pass, no matches.
- Targeted real-Postgres class journey `classes.integration.test.ts` — pass, 17/17. The full suite also passed on retry with bounded workers; an earlier unbounded run had a timeout under machine load.

## Promotion decision

**Do not advance local `main`.** Criteria 1–7 and 10 fail. Keep `main` at `d0f59a1c44e499dc69455ed3ad3e0a2dae9883de` until every criterion above passes. This gate record is a local evidence snapshot; it does not claim GitHub CI is green and does not authorize a push.
