# AGENTS.md — Athlentry

You are building **Athlentry**, a production-grade, multi-sport, multi-tenant management platform for youth and amateur sports organizations (rec leagues, competitive clubs, academies/class-based programs, tournament operators, parks & recreation departments and governing associations). This session's scope is the **web platform** (admin console, family/athlete portal, coach/official/volunteer views, public org websites, platform-staff console). A native iOS app will be built later against the same API, so every capability must be exposed through the documented, versioned API.

## Read before doing anything

1. `docs/codex/00-START-HERE.md` — mission, definition of done, decisions already made, working rules.
2. `docs/codex/PROGRESS.md` — where the previous session stopped. Resume from the first unchecked item.
3. The spec file for the phase you are working on (listed in 00-START-HERE).

The specification in `docs/codex/` is authoritative. Where it says **MUST**, do it exactly. Where it is silent, choose the option that is most protective of (in order) child safety, financial correctness, data privacy, and then simplicity; record the choice in `docs/codex/DECISIONS.md`. Do not stop to ask the owner questions; the owner has delegated all product and engineering decisions to this specification.

## Superseded documents

`BACKEND-HANDOFF.md`, `docs/FOUNDATION*.md`, `docs/REMAINING-WORK.md`, `docs/REPLICATION.md`, `docs/RESUME.md`, `docs/TEAM-REGISTRATION.md`, `docs/NAVIGATION-VERIFICATION.md`, `docs/FRONTEND-OWNERSHIP.md`, `docs/BACKEND-*.md` describe an earlier LeagueApps-replica effort. Their ownership splits ("do not edit src/"), exclusions ("no payments integration", "defer tryouts") and finish lines **no longer apply**. Phase 0 moves them to `docs/archive/`. Useful engineering patterns in the old code are listed in `00-START-HERE.md §7`.

## Non-negotiable rules

- Never move real money. Stripe runs in test mode in every environment you operate. Never use live keys.
- Never send real email/SMS/push in tests or local development. Use the fake/preview adapters.
- Never commit secrets, `.env` files, database files, or uploaded files. Never print secrets in logs.
- Never inspect, log into, scrape or mutate any third-party account (including any LeagueApps account).
- Never hard-delete financial, compliance, waiver, audit or safety records. Archive or anonymize per spec.
- Every tenant query goes through the org-scoped database helper (`withOrg`). No raw tenant queries outside it.
- **Keep the existing design system exactly.** The current look (colors, fonts, type scale, spacing, radii, borders, shadows, dark chrome header/sidebar, component shapes and states) is the owner's custom redesign and is final. Port its CSS values verbatim into `web/src/ui/tokens.css`; build every new screen and component from those tokens and existing component styles. No new palette, fonts, dark mode, CSS framework (Tailwind etc.) or component library (MUI, shadcn, Chakra, Mantine etc.). Rules in `01-ARCHITECTURE.md §11a`.
- No placeholder UI. A visible button, menu item or setting either works end-to-end or is not rendered.
- No `TODO`/`FIXME` left in shipped code paths. Unfinished work is tracked in `PROGRESS.md`, not in code.
- Every phase ends green: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e` and `npm run build` all pass before a phase is checked off.

## Commands (available after Phase 0)

```
npm run dev            # Postgres (docker compose), API, worker and Vite together
npm run db:up          # start local Postgres + stripe-mock + mailpit containers
npm run db:migrate     # apply migrations
npm run db:seed        # load deterministic demo organizations
npm run typecheck
npm run lint
npm test               # Vitest unit + integration (real Postgres)
npm run test:e2e       # Playwright
npm run build
npm run openapi        # regenerate docs/api/openapi.json
```

## Commit discipline

Small, focused commits using Conventional Commits (`feat(registration): ...`). One logical change per commit. Update `docs/codex/PROGRESS.md` in the same commit that completes an item. Work on branch `rebuild/phase-N` per phase; merge to `main` only when the phase gate passes.
