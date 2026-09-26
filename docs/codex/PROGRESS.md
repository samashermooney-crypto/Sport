# PROGRESS

> Codex: keep this file current. Update it in the same commit that completes an item. Before stopping a session, write the "Next steps" block.

## Next steps
- Phase 0 is complete on `rebuild/phase-0`. Create `rebuild/phase-1` from this branch and copy Phase 1 tasks from `10-PHASES-FOUNDATION.md` here before implementation. Keep phases in order and meet the Phase 1 gate before checking it complete.

## Phase status

| Phase | Name | Status | Evidence |
|---|---|---|---|
| 0 | Repository reset and tooling | complete | Local gate green; [GitHub Actions run 36279198481](https://github.com/samashermooney-crypto/Sport/actions/runs/36279198481) passed all 9 jobs on `rebuild/phase-0`. |
| 1 | Platform core | not started | |
| 2 | People, households, forms, imports | not started | |
| 3 | Sport engine, programs, teams, facilities | not started | |
| 4 | Payments and finance | not started | |
| 5 | Registration | not started | |
| 6 | Evaluations and team formation | not started | |
| 7 | Compliance and safety | not started | |
| 8 | Scheduling and facilities | not started | |
| 9 | Game day, results, tournaments, officials | not started | |
| 10 | Communications | not started | |
| 11 | Volunteers, team finance, fundraising, store | not started | |
| 12 | Academy / class mode | not started | |
| 13 | Federation | not started | |
| 14 | Reporting, website, exports | not started | |
| 15 | Onboarding, imports, demo, AI assist | not started | |
| 16 | Production hardening and launch gate | not started | |

## Current phase checklist

### Phase 0 — Repository reset and tooling

- [x] Move old app and superseded docs to `legacy/` and `docs/archive/`; preserve local SQLite data and landing assets; remove tracked build artifacts. Verified `data/fieldhouse.sqlite` remains on disk and is ignored; no tracked `dist/` or build info files.
- [x] Create `01 §1` layout, strict TypeScript project references, and `@shared/*`, `@server/*`, `@web/*` aliases. `npm run typecheck` passed.
- [x] Add ESLint flat config, Prettier, size-limit, knip, lint-staged, and simple-git-hooks. Lint, size, knip and the pre-commit hook passed; main bundle 60.61 KB gzip under 200 KB.
- [x] Add Postgres 16, stripe-mock, and Mailpit Compose services with app/admin roles and dev/test databases; add `db:up` and `db:down`. `npm run db:up` reported all services healthy.
- [x] Make `npm run dev` bring up Compose, migrate, and start API, worker, and Vite with prefixed logs and clean Ctrl-C; update `.claude/launch.json`. Manual startup and Ctrl-C shutdown verified.
- [x] Configure isolated Postgres template-clone server Vitest, jsdom web Vitest, and seeded Playwright e2e with axe helper and failure traces. `server/src/app.test.ts` and `web/src/auth/SignIn.test.tsx` passed (3 tests); `e2e/sign-in.spec.ts` passed on Chromium desktop and WebKit mobile with axe.
- [x] Add CI for Node 24, Postgres, stripe-mock, typecheck, lint, coverage, Chromium and WebKit mobile e2e, build, OpenAPI freshness, and production audit. [Run 36279198481](https://github.com/samashermooney-crypto/Sport/actions/runs/36279198481) passed all 9 jobs.
- [x] Fill `PROGRESS.md`, `DECISIONS.md`, `docs/ENVIRONMENT.md`, and `.env.example` without secrets.
- [x] Rename active identifiers to Athlentry; update README with honest rebuild status. Historical names remain in the untouched legacy archive and old mockups.

### Phase 0 acceptance criteria

- [x] Fresh local clone of commit `1326e0e`: `npm ci && npm run db:up && npm run dev` served the Athlentry sign-in shell at `http://127.0.0.1:5173`; direct `GET /healthz` returned 200. `e2e/sign-in.spec.ts` confirmed no dead links/buttons and passed axe on both browsers. Ctrl-C stopped all processes and containers.
- [x] `npm test` runs a server example against an isolated PostgreSQL database and a web component example. `server/src/app.test.ts` asserted the template-cloned database and migration ledger; `web/src/auth/SignIn.test.tsx` passed.
- [x] CI passes on the branch: [GitHub Actions run 36279198481](https://github.com/samashermooney-crypto/Sport/actions/runs/36279198481), commit `34997b5`.
- [x] Legacy code is preserved untouched in `legacy/`; nothing outside `legacy/` imports it. Byte comparison with pre-rebuild HEAD found 0 differences across 170 old source/config files and 13 archived docs.
- [x] Local phase gate passes: `npm run typecheck`, `npm run lint`, `npm test` (3 passed), `npm run test:e2e` (2 passed), `npm run build`. `npm test -- --coverage`, `npm run size`, `npm run knip`, `npm run openapi`, `npm audit --omit=dev --audit-level=high` and `docker build -t athlentry-phase0 .` also passed.
