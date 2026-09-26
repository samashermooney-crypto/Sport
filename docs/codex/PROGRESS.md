# PROGRESS

> Codex: keep this file current. Update it in the same commit that completes an item. Before stopping a session, write the "Next steps" block.

## Next steps
- Complete Phase 0 on `rebuild/phase-0`. Finish tooling, database-backed test setup, CI, and run every phase gate command before checking the phase complete.

## Phase status

| Phase | Name | Status | Evidence |
|---|---|---|---|
| 0 | Repository reset and tooling | in progress | Branch `rebuild/phase-0` created; legacy code and superseded docs moved. |
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
- [ ] Create `01 §1` layout, strict TypeScript project references, and `@shared/*`, `@server/*`, `@web/*` aliases.
- [ ] Add ESLint flat config, Prettier, size-limit, knip, lint-staged, and simple-git-hooks.
- [ ] Add Postgres 16, stripe-mock, and Mailpit Compose services with app/admin roles and dev/test databases; add `db:up` and `db:down`.
- [ ] Make `npm run dev` bring up Compose, migrate, and start API, worker, and Vite with prefixed logs and clean Ctrl-C; update `.claude/launch.json`.
- [ ] Configure isolated Postgres template-clone server Vitest, jsdom web Vitest, and seeded Playwright e2e with axe helper and failure traces.
- [ ] Add CI for Node 24, Postgres, stripe-mock, typecheck, lint, coverage, Chromium and WebKit mobile e2e, build, OpenAPI freshness, and production audit.
- [ ] Fill `PROGRESS.md`, `DECISIONS.md`, `docs/ENVIRONMENT.md`, and `.env.example` without secrets.
- [ ] Rename active identifiers to Athlentry; update README with honest rebuild status.

### Phase 0 acceptance criteria

- [ ] Fresh clone: `npm ci && npm run db:up && npm run dev` serves the Athlentry sign-in skeleton at `http://127.0.0.1:5173`, with no dead links, and `GET /healthz` returns 200.
- [ ] `npm test` runs a server example against an isolated PostgreSQL database and a web component example.
- [ ] CI passes on the branch.
- [ ] Legacy code is preserved untouched in `legacy/`; nothing outside `legacy/` imports it.
- [ ] Phase gate passes: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`.
