# 30 — Testing and Quality

## §1 Test layers

| Layer | Tool | Location | Runs against |
|---|---|---|---|
| Pure logic (sport engine, money, algorithms, permissions) | Vitest + fast-check | `shared/src/**/*.test.ts`, `server/src/modules/*/logic.test.ts` | nothing external |
| Service/domain | Vitest | `server/src/modules/*/service.test.ts` | isolated real Postgres DB per test file (template clone) + fake adapters + injected clock |
| HTTP/API | Vitest + supertest | `server/src/modules/*/routes.test.ts` | same, through `app.ts` factory |
| Webhooks | Vitest | `server/src/integrations/*/webhooks.test.ts` | recorded fixture payloads signed with test secrets |
| Stripe | stripe-mock container for API shape + recorded event fixtures for flows; optional `STRIPE_TEST_SECRET_KEY` suite tagged `@stripe-live-test` (skipped when unset) |
| Web components | Vitest + Testing Library + jsdom | `web/src/**/*.test.tsx` | mocked API via MSW |
| End-to-end | Playwright + @axe-core/playwright | `e2e/*.spec.ts` | full stack with `e2e` seed, Mailpit API for email assertions, stripe-mock |
| Load | k6 | `perf/` | staging-like environment |

Rules:
- Every bug fix adds a failing test first.
- No test depends on another test's data. No sleeps; use injected clock and Playwright auto-waiting.
- Tenancy and permission tests are generated from route metadata so new routes are covered automatically (each route declares `permission`, `resource`, `scope` metadata; a test iterates all routes).
- Snapshot tests only for generated documents (PDF text extraction, ICS, CSV headers, OpenAPI).

## §2 Required cross-cutting suites

1. **Tenancy suite** — for each route with ids: other-org id → 404; RLS direct-SQL test for every tenant table.
2. **Permission matrix** — roles × routes expected allow/deny table checked in (`server/test/permission-matrix.json`), plus scoped-role cases (program-scoped director cannot touch another program).
3. **Money invariants** — property-based sequences (§4 of `20`), reconciliation totals, idempotent replays.
4. **Capacity concurrency** — parallel checkouts (see Phase 5).
5. **Child-safety** — SafeSport messaging rules, compliance gating, medical access tiers, minor account rules.
6. **i18n completeness** — missing Spanish keys fail.
7. **Accessibility** — axe on every e2e page; keyboard-only checks for dialogs, menus, drag-and-drop alternatives.
8. **Route crawler** — per role, visit every route in the navigation config; fail on errors, unhandled rejections, console errors, or unexpected empty error states.
9. **Migration safety** — apply all migrations to an empty DB and to the previous release's schema with seed data; run app smoke tests.
10. **OpenAPI freshness** — regenerate and diff.
11. **Design parity** (`01 §11a`) — screenshot comparison of shell and shared components against `e2e/visual-reference/`; token-equality test against `e2e/visual-reference/tokens.json` (survives the Phase 16 deletion of `legacy/`); dependency check failing if a CSS framework or styled component library is added. Every new screen added in Phases 2–15 gets a screenshot baseline reviewed against the rules in `01 §11a`.

## §3 Required Playwright journeys (each at desktop 1440×900 and iPhone 13 viewport unless noted)

1. Org sign-up → MFA → invite admin → role change revokes session (Phase 1).
2. Guardian accepts invitation and edits child medical info (Phase 2).
3. Import 2,000 people with preview and rollback (desktop only) (Phase 2).
4. Season wizard for volleyball club + generate teams (Phase 3).
5. Season rollover preview and commit (desktop) (Phase 3).
6. Stripe onboarding (mock) → first payment → partial refund with approval (Phase 4).
7. Installment plan with autopay; failed retry; family updates card; success (Phase 4, clock-controlled).
8. New family registers 2 kids with sibling discount, waiver, ACH, confirmation email (en and es) (Phase 5).
9. Returning family re-registers in ≤ 4 screens (Phase 5).
10. Waitlist offer and acceptance (Phase 5).
11. Team entry by external adult captain with player invites (Phase 5).
12. Tryout check-in, offline evaluator scoring, placement board auto-balance, offers accepted with deposit (Phase 6).
13. Coach compliance gating and activation after credential approval (Phase 7).
14. Concussion report → return-to-play clearance (Phase 7).
15. Schedule generator run → review → apply → publish → families notified (Phase 8).
16. Rainout closure → notifications → reschedule request approved (Phase 8).
17. Coach offline game day: attendance, lineup with min-play warning, score entry, sync (Phase 9).
18. Double-elimination tournament with external teams through final (desktop) (Phase 9).
19. Swim meet results with team scoring (desktop) (Phase 9).
20. Officials assignment, decline, reassign, pay batch (Phase 9).
21. Bilingual campaign with quiet hours and unsubscribe (Phase 10).
22. Team chat with SafeSport guardian inclusion (Phase 10).
23. Volunteer shift signup, check-in, buyout (Phase 11).
24. Academy monthly tuition with proration, make-up class, level promotion (Phase 12).
25. Federation inter-club league: entries, shared-field schedule, results, standings (desktop) (Phase 13).
26. Report builder save + schedule; privacy deletion (desktop) (Phase 14).
27. New org completes onboarding checklist (Phase 15).

## §4 Fixtures and seeds

- `db/seeds/` generators use a seeded PRNG (`@faker-js/faker` with fixed seed) — identical output every run.
- Profiles: `e2e` (small, fast, deterministic ids for tests), `demo` (the six orgs in Phase 15), `load` (100 orgs, 150k people…).
- Test Stripe fixtures in `server/test/fixtures/stripe/*.json` (captured from Stripe docs/test mode; secrets removed).
- Email assertions use Mailpit's HTTP API; SMS/push assertions use the preview outbox API (dev/test only routes, disabled in production).

## §5 Code quality rules

- TypeScript strict; no `any` (lint error) except in generated files; no non-null assertions in server code.
- Functions that change money, capacity or compliance status live in services with explicit transaction parameters and are the only writers of those tables.
- Every Zod schema for requests uses `.strict()` (unknown keys rejected).
- All dates computed in org timezone through the shared date utilities; lint rule forbids `new Date().getDay()`-style local-time calls in server code.
- UI components never fetch directly; they use query hooks from their feature's `api.ts`.
- Error messages shown to users are written for humans, specific, and localized; internal errors are logged with a request id shown to the user ("Reference: 7F3K…").
