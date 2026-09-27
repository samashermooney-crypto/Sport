# 50 — Parallel Execution Plan

This plan **supersedes the "strictly in order" rule in `00-START-HERE.md §6`** and the per-phase branch/merge rule in `AGENTS.md`. The phase specs, acceptance criteria and quality gates are unchanged; only who works on what, when, and how work is integrated changes.

Several Codex sessions ("tracks") work at the same time, each in its own git worktree and branch, each owning specific directories. One integration branch (`rebuild/trunk`) collects finished work. `main` moves only at milestones.

---

## 1. Branches and worktrees

| Branch | Purpose | Who writes |
|---|---|---|
| `main` | Milestone releases only (M0 = Phase 0, M1 = beta scope, M2 = full platform) | Integrator, at milestone gates |
| `rebuild/trunk` | Integration branch. Always green. All tracks branch from it and are merged back into it | Integrator only |
| `track/a-core` | Track A (continues the work that was on `rebuild/phase-1`) | Track A |
| `track/<letter>-<name>` | Other tracks | That track only |

Worktree layout (siblings of the main checkout):
```
/Users/sammooney/Sport              ← Track A (track/a-core)
/Users/sammooney/Sport-trunk        ← integration worktree (rebuild/trunk), used only for merges
/Users/sammooney/Sport-b-logic      ← Track B
/Users/sammooney/Sport-c-adapters   ← Track C
/Users/sammooney/Sport-d-design     ← Track D
/Users/sammooney/Sport-e-finance    ← Track E
(after S1) Sport-f-safety, Sport-g-schedule, Sport-h-comms
```
Create a worktree: `git worktree add ../Sport-b-logic -b track/b-logic rebuild/trunk`.

Each worktree runs its own Postgres test databases. To avoid port clashes, only the Track A worktree runs `npm run dev` on the default ports; other tracks run tests (`npm test`, targeted Playwright with `PORT_OFFSET`, see §6) and set `COMPOSE_PROJECT_NAME=athlentry_<track>` plus the port offset when they need their own containers. Track A adds `PORT_OFFSET` support to `scripts/dev.mjs`, `docker-compose.yml` and `playwright.config.ts` as its first task (§4).

## 2. Ownership (what each track may edit)

A track edits only the paths it owns plus files it creates inside its own folders. Needing a change elsewhere → write it as a request in its track file (§5); the owner does it.

| Track | Owns |
|---|---|
| **A — core** | `db/migrations` range 0010–0999, `server/src/db/**`, `server/src/lib/**`, `server/src/modules/{auth,accounts,orgs,platform,people,households,medical,forms,waivers,imports,sports,seasons,programs,offerings,teams,rosters,facilities,registration,evaluations,audit,notifications}/**`, `server/test/**` (factories), `web/src/{auth,console,portal,platform,app.tsx,main.tsx,api}/**` for its features, `scripts/**`, registries (§3), `package.json` dependency merges (integrator) |
| **B — logic** | `shared/src/sport/**`, `shared/src/algorithms/**`, `shared/src/policies/**`, `shared/src/recurrence.ts` (+ tests). No database, no HTTP, no UI |
| **B, second queue (platform infrastructure)** | Added after Track B finished its logic queue. Migration range 0600–0699; `server/src/modules/{platform,audit,notifications,jobs}/**`; new files `server/src/lib/{pagination,idempotency,version-check,sse}.ts` (+ tests); `scripts/openapi.ts` and OpenAPI generation; `web/src/platform/**`; `web/src/console/audit/**`; notification inbox UI in `web/src/portal/notifications/**`. Track A no longer does Phase 1 tasks 9, 10, 13, 14, 15. |
| **C — adapters** | `server/src/integrations/**` except `captcha/` (Track A finishes it) and `stripe/` (Track E), migration range 0500–0599 (files module only), `server/src/modules/files/**`, email templates layout in `server/src/integrations/email/templates/**` |
| **D — design** | `web/src/ui/**`, `e2e/visual-reference/**`, `e2e/design/**`, dev-only `/__ui` pages in `web/src/ui/dev/**`. After Track A marks identity screens done (task 3/17), D may restyle `web/src/auth/**` to use the shared components |
| **E — finance** (starts in wave 1) | migrations 1000–1999, `server/src/integrations/stripe/**`, `server/src/modules/{finance,payments,checkout,team-finance,fundraising,sponsors,store}/**`, `web/src/{console,portal}/money/**`, `scripts/stripe-smoke.ts` |
| **F — safety** (after S1) | migrations 2000–2999, `server/src/modules/{compliance,safety,discipline}/**`, `web/src/{console,portal}/safety/**` |
| **G — schedule** (after S1) | migrations 3000–3999, `server/src/modules/{scheduling,contests,standings,tournaments,officials,attendance}/**`, `web/src/{console,portal}/schedule/**` |
| **H — comms** (after S1) | migrations 4000–4999, `server/src/modules/{communications,chat}/**`, `web/src/{console,portal}/messages/**` |

Wave 3 tracks (after M1) get ranges 5000+ and are assigned in §7.

Migration rules: 4-digit prefix inside your range, next free number in your range. A migration may only create or alter tables your track owns (table ownership = the module that owns it per `01 §1`; the spine migration in §4 creates them, the owning track evolves them). Never edit an applied migration.

## 3. Conflict hotspots and the registry rule

Shared files that every module would otherwise edit are replaced by **generated registries** (Track A builds this first, §4):

- Each server module exports `module.ts` with `{ name, router?, jobs?, permissions?, notificationTypes?, errorCodes?, configSchema? }`.
- Each web feature exports `routes.tsx` and `nav.ts` (items with area, group, order, required permission).
- Each integration exports `config.ts` (env Zod schema).
- `npm run registry` scans these files and writes `server/src/generated/registry.ts`, `web/src/generated/registry.ts`, `shared/src/generated/errors.ts`, `shared/src/generated/permissions.ts`. Generated files are committed. CI fails if they are stale.
- `server/src/app.ts`, `server/src/worker.ts`, `server/src/config.ts`, the web router and navigation read only from the generated registries. Nobody hand-edits them for a new module.

Other generated files (`server/src/db/types.ts`, `docs/api/openapi.json`, registries): on merge conflicts **never hand-merge** — regenerate (`npm run db:migrate && npm run registry && npm run openapi`) and commit.

`package.json` / lockfile: **any track may add the dependencies it needs** in a commit that touches only `package.json` and `package-lock.json` on its own branch. On conflict, the integrator takes both sides' dependency lists and runs `npm install`. New worktrees need `npm ci` before tests run. If a session's sandbox cannot reach the npm registry, record the exact package and version in the track file and continue with other work; the owner installs it.

## 4. Waves

### Wave 1 — now

| Track | Work queue (in order) |
|---|---|
| **A** | 1) Commit current work; create `rebuild/trunk` and `track/a-core` (§8 kickoff). 2) `PORT_OFFSET` support. 3) Registry system (§3) and move existing auth wiring onto it. 4) Module generator `npm run gen:module <name>` producing migration stub (in the caller's range), shared schemas, repo/service/policy/routes with tenancy+permission test scaffolds, web list/detail/form screens using Track D components, and nav entry. 5) **Schema spine** and test factories (below), before remaining Phase 1 work. 6) Finish Phase 1 tasks 3–8 and 16–17 with Track D's components (B owns 9–10 and 13–15; C owns 11–12). 7) Phase 1 gate. 8) Phase 2 (people is the **exemplar module** — build it as the reference implementation Luna tracks will copy). 9) Phase 3 (non-logic parts). 10) **Luna enablement** (§4a). — *Sol checkpoint S1 (§4a); after S1 this track runs on Luna:* 11) Phase 5 (registration flows and UI on top of E's checkout core). 12) Phase 6. |
| **B** | Implement everything in `03-SPORT-ENGINE.md` and every pure function in `20-ALGORITHMS.md` (§1 already exists in `shared/src/money.ts` — extend, do not replace): `sport/schema.ts`, all templates, `age.ts` (all methods incl. grade from graduation year; reuse `shared/src/dates.ts` leap-day rule), `eligibility.ts`, `results.ts`, `stats.ts`, `standings.ts`; `algorithms/{pricing,fees,installments,invoice-state,dunning-schedule,capacity-math,waitlist,schedule-generator,team-balancer,evaluation,brackets,proration}.ts`; `recurrence.ts` (`15-SPEC-CLARIFICATIONS.md §C1`). Each with unit + property tests, ≥ 95% line coverage, golden-file tests per sport template. Also the **safety and money policies later Luna tracks will call** (pure functions, exhaustive tests), in `shared/src/policies/`: `compliance-gate.ts` (given role requirements, a person's credentials, age and date → eligible / missing list / expiry date; override rules from `04 §5`), `safesport.ts` (given a proposed message/conversation membership with ages and guardian links → required guardian additions or `SAFESPORT_GUARDIAN_REQUIRED`, per `04 §4`), `refund-policy.ts` (policy rules by date → proposed refund per line, per Phase 5 task 7), `quiet-hours.ts` (Phase 10 rule), `fcra-timeline.ts` (pre-adverse/adverse business-day rules, Phase 7). Deliver in this order so dependents unblock early: age/eligibility → recurrence → results/standings → pricing/fees/installments/invoice-state/capacity-math → policies → brackets → schedule generator → team balancer → evaluation → proration. Mark each "ready" in the track file as it lands. |
| **B (second queue, Sol)** | After the logic queue: Phase 1 **task 10** (pg-boss setup, job registry through the module registry's `jobs`, worker heartbeat, failed-job visibility) → **task 15** (OpenAPI generation from shared Zod schemas covering every route, error-code enum wiring, cursor pagination, idempotency middleware per `01 §5`, optimistic-concurrency version-check helpers; migrate existing auth/orgs routes to them) → **task 14** (audit module: redaction per `04 §6`, Restricted-read audit helper, audit viewer component) → **task 13** (notifications core: code-defined catalog, inbox API, SSE stream `/api/v1/stream` with Postgres LISTEN/NOTIFY, preferences API; uses spine tables once on trunk) → **task 9** (platform console: org list/detail, suspend/reactivate, plans, feature flags, platform staff, audited read-only impersonation with banner and 60-minute expiry, system health, `scripts/create-platform-admin.ts`). Each with the Phase 1 acceptance criteria that apply. |
| **C** | 1) Phase 1 task 11 (files module end to end, migration 0500+). 2) Phase 1 task 12 (email: Resend + Mailpit + Fake adapters behind the existing `EmailSender` interface, extended for HTML + attachments; React Email base layout with org branding; en/es rendering; keep `FakeEmailSender` behavior backward compatible for Track A's tests). 3) (Stripe moved to Track E.) 4) `SmsSender` (Twilio Messaging Service, preview, fake) incl. inbound STOP/START/HELP parsing and status-callback signature validation. 5) `PushSender` web-push delivery (Track A owns subscription storage; C owns sending + invalid-subscription detection). 6) `BackgroundCheckProvider` (manual + Checkr with recorded fixtures). 7) `Geocoder` (optional HTTP, allow-listed host). |
| **E** | Starts now. 1) Stripe `PaymentsGateway` (all operations in `01 §8`) with the `stripe` SDK, stripe-mock tests, webhook signature verification, typed event parsing and a fixture library for every event type Phase 4 lists; Apple Pay domain registration; Express account creation/links; `scripts/stripe-smoke.ts`. 2) When the schema spine is on trunk: **Phase 4 complete** (all tasks, including installment templates per `15 §C13`). 3) **Phase 5 money core** in `server/src/modules/checkout/**`: checkout session state machine, capacity holds service (`20 §2`, using B's capacity math), pricing snapshot service wiring B's pricing pipeline (discounts, sibling rules, aid, credits, service fee, tax), checkout → PaymentIntent → confirmation/failure transitions (`20 §4`), waitlist offer holds (`20 §12`), refund-policy application service (using B's `refund-policy.ts`), idempotency, and the Phase 5 oversell/concurrency acceptance test. Expose a documented service API (`checkout/service.ts`) that Track A's registration UI calls. 4) Luna enablement notes for the finance area (§4a). — *Stops at Sol checkpoint S1; Phase 11 finance parts are done later on Luna.* |
| **D** | 1) Finish legacy reference capture (`01 §11a` step 10) if incomplete. 2) Port legacy components with identical appearance (primitives first: Button, IconButton, Link, Field, Input, Textarea, Select, Checkbox, Radio, Switch, Badge/status pill, Card, Table, Tabs, Dialog, Toast, Banner, EmptyState, ErrorState, Skeleton, PageHeader, app shell chrome with org switcher slot and nav rendered from the registry). Publish each batch to trunk quickly — Track A builds screens on them. 3) Remaining `01 §11` components (DateInput, TimeInput, DateRange, MoneyInput, PhoneInput, Combobox, FileUpload, Avatar, Tag, DataList, Stepper, Drawer, Sheet, Pagination, Calendar month/week/day/agenda + resource view, Timeline, StatTile, Chart, RichTextEditor, SignaturePad, QRCode, PrintLayout, drag-and-drop Board with keyboard alternative, Bracket view, Chat thread). 4) Design parity suite (`30 §2.11`). 5) Mobile bottom tab bar, command palette, global search UI shell. 6) Restyle `web/src/auth/**` onto shared components once A marks identity done. |

**Schema spine (Track A, wave 1 step 7).** One migration series (range 0100–0199) creating every table in `02-DATA-MODEL.md` sections **C, D, E, G, H, I, J, L, N, Q** plus remaining **B** tables, with constraints, indexes, forced RLS, composite tenant FKs, and triggers from `15-SPEC-CLARIFICATIONS.md`. Also: shared Zod entity schemas in `shared/src/schemas/entities/**`, generated Kysely types, and `server/test/factories.ts` (typed factories that insert valid rows for every spine table inside `withOrg`, so other tracks can test without waiting for UI/services). Spine = the contract for wave 2. Changes to spine tables after this go through the owning track's range.

## 4a. Model assignment and the Sol checkpoint (S1)

The owner runs **GPT-6 Sol** for Tracks **A, B and E** and **GPT-6 Luna** for Tracks **C and D** now, and for **every track after S1** (including Track A's continuation as integrator and all of F, G, H and wave 3). Work is ordered so the hardest, highest-risk code is finished by Sol before the switch, and Luna afterwards mostly composes proven pieces following explicit patterns.

**S1 is reached when `rebuild/trunk` contains, all green and integrated:**
1. Phase 1 gate passed; registry; module generator; `PORT_OFFSET`.
2. Schema spine + test factories; Phase 2 (with `people` as the exemplar module); Phase 3.
3. Track B queue complete (all sport engine, algorithms and `shared/src/policies/**`).
4. Track E queue complete: Stripe gateway, Phase 4, Phase 5 money core.
5. **Luna enablement** (Track A, with E adding the finance section):
   - `docs/codex/60-LUNA-PLAYBOOK.md`: how to build a module here, step by step, pointing to exact exemplar files (people module end-to-end, a finance flow, a policy call); the checklist a track runs before marking work ready; common mistakes seen so far (from reviews and DECISIONS.md).
   - Guardrails in CI so mistakes fail fast instead of relying on judgment: route-metadata-driven tenancy and permission suites run for every route automatically; lint rules forbidding `db`/`sql` imports in modules outside `repo.ts`, forbidding tenant-table queries outside `withOrg`, forbidding direct writes to money/capacity/compliance tables outside their owning services, forbidding float arithmetic on `*_cents` variables; a test that every route has permission metadata; a test that every Restricted field read writes an audit entry.
   - Service APIs that Luna tracks must call instead of re-implementing: `checkout/service.ts`, finance services, `shared/src/policies/*` (compliance gate, SafeSport, refund policy, quiet hours, FCRA timeline).
6. Zero open review findings for A, B and E.

When S1 is reached, Track A writes "S1 reached" in `docs/codex/tracks/A.md` and stops; the owner switches models and starts the post-S1 sessions (§8). Tracks F (safety) and H (comms) MUST call `shared/src/policies/*` for every gating and SafeSport decision; re-implementing those rules is a review finding.

### Wave 2 — starts when trunk has: Phase 1 gate passed, schema spine, test factories, registry, module generator, D's primitives, B's pricing/fees/installments/invoice-state (E is already running from wave 1). F, G, H start after S1 on Luna.

| Track | Phases | Notes |
|---|---|---|
| **A** | 2 → 3 → (S1) → 5 → 6 | Phase 5 builds registration flows/UI on E's checkout core |
| **E — finance** | Stripe gateway, 4, Phase 5 money core (Sol, before S1); Phase 11 finance parts after M1 (Luna) | Uses B's pure money logic |
| **F — safety** | 7 (Luna, after S1) | Wraps `shared/src/policies/compliance-gate.ts` as `assertEligibleForRole()`; A/G/H call it |
| **G — schedule** | 8 → 9 | Uses B's recurrence, generator, standings, brackets |
| **H — comms** | 10 | Start with channels, preferences, notification fan-out, chat, SafeSport policy (from F; until merged, implement against the policy interface in `04 §4` and F adopts it). Add audience selectors for registrations/balances as A/E land them |

B, C, D sessions end when their queues are done (or D continues building shared components on request).

### Wave 3 — after M1

Tracks I (academy, Phase 12, range 5000), J (federation, Phase 13, range 6000), K (reporting + website + exports, Phase 14, range 7000), L (volunteers Phase 11 part + onboarding/imports/demo/AI Phase 15, range 8000). E continues Phase 11 finance parts. Phase 16 full gate last (range 9000 for any hardening migrations).

## 5. Track files and coordination

Each track keeps `docs/codex/tracks/<LETTER>.md` (only that track edits it):
```
# Track B — logic
Status: working | blocked | ready-for-integration | done
Ready for integration: <commit range> — <one line>
Requests to other tracks: <track>: <request> (date)
Blocked on: <what>
```
`PROGRESS.md` is edited **only by the integrator** (phase status and evidence links), so tracks never conflict on it. Tracks put detail in their track file, one line per item.

## 6. Integration and quality gates

**Per task (inside a track):** targeted tests only — the files changed plus their module's tests; Playwright only for specs touching the changed screens, Chromium only. Keep it fast.

**Ready for integration (track):** track's full test suite, typecheck, lint, registry/openapi/codegen fresh, affected Playwright specs on Chromium + WebKit mobile, self-review against the relevant spec sections (write 3–5 lines in the track file: what was checked, any deviation → DECISIONS.md entry). Set status `ready-for-integration` on the local branch; pushing a track branch is optional.

**Integration (integrator = Track A, at the start of each of its tasks, in `../Sport-trunk`):** read readiness with `git show track/<x>:docs/codex/tracks/<X>.md` and merge each ready LOCAL branch into `rebuild/trunk` (regenerate generated files on conflict). Run the **full** gate (`typecheck`, `lint`, `test`, full `test:e2e`, `build`, registry/openapi freshness), push trunk, let CI run. If red: revert the merge on trunk and set the track's status back with the failure. Then every track merges `rebuild/trunk` into its branch at the start of its next task.

**Independent review (Claude):** the owner periodically asks Claude to review what landed on trunk. Findings are written to `docs/codex/reviews/<track>-<yyyymmdd>.md` in the main checkout (untracked); Track A commits new review files at the start of its next task. **The owning track's next task is always to fix open review findings** before new work. Reviews do not block merges; milestone gates require zero open findings.

**Phase acceptance:** a phase is marked complete in `PROGRESS.md` by the integrator when all its acceptance criteria are met on trunk. Phases complete in any order that dependencies allow.

**Milestones (`main` moves only here):**
- **M0** — Phase 0 (already passed): fast-forward `main` to the Phase 0 commit now.
- **M1 — private beta for rec leagues:** Phases 0, 1, 2, 3, 4, 5, 7, 8, 9, 10 complete + Phase 16 §1 (security), §4 (reliability/ops), §5 (legal drafts) applied to that scope + zero open review findings. Then the owner runs a private beta with 1–2 friendly leagues while wave 3 continues. Beta feedback is written to `docs/codex/BETA-FEEDBACK.md` and turned into tasks before wave 3 phases that it affects.
- **M2 — full platform:** all phases + full Phase 16 launch gate.

## 7. Efficiency rules for every session

1. `PROGRESS.md` and track files: one line per item, evidence as a link or test name. No narrative paragraphs.
2. Don't re-read whole spec files every task; read the sections the task cites.
3. Use the module generator for every new module; then specialize.
4. Port from `legacy/` when a legacy implementation exists (forms engine, waiver evidence/PDF, commerce, schedule CSV import, transfer rules, standings vocabulary, member invitation rules) — adapt to the new schema, keep its tests' intent.
5. Queue work: when a task finishes, start the next queued task immediately; only stop when the queue is empty, you are blocked (record it), or context is nearly full (write next steps in the track file).
6. Never wait on another track: implement against the contract (spine schema, interface, factory) and let integration connect it.
7. Flaky test = fix or quarantine (`test.fixme` with an entry in the track file and a follow-up task) the same day; never let it block others.

## 8. Kickoff prompts

The owner pastes these. Every prompt assumes the session starts in the worktree named.

**Track A (existing session, `/Users/sammooney/Sport`)** — see the owner's message; it transitions the current Phase 1 session.

**Track B (`/Users/sammooney/Sport-b-logic`, GPT-6 Sol):**
> You are Track B (logic) of the Athlentry rebuild. Read AGENTS.md, docs/codex/50-PARALLEL-PLAN.md (fully), docs/codex/15-SPEC-CLARIFICATIONS.md, docs/codex/03-SPORT-ENGINE.md and docs/codex/20-ALGORITHMS.md. You own only the paths listed for Track B in 50 §2. Execute the Track B queue in 50 §4 in order, following the integration rules in 50 §6 and efficiency rules in 50 §7. Keep docs/codex/tracks/B.md current. Do not edit PROGRESS.md. Work continuously through the queue.

**Track E (`/Users/sammooney/Sport-e-finance`, GPT-6 Sol):**
> You are Track E (finance) of the Athlentry rebuild. Read AGENTS.md, docs/codex/50-PARALLEL-PLAN.md (fully, especially §4 Track E queue and §4a), docs/codex/15-SPEC-CLARIFICATIONS.md, docs/codex/20-ALGORITHMS.md §1–§5, §10, §12, Phase 4 and Phase 5 in docs/codex/11-PHASES-OPERATIONS.md, and docs/codex/02-DATA-MODEL.md §E and §L. You own only the paths listed for Track E in 50 §2 and migration range 1000–1999. Start with the Stripe gateway now; begin Phase 4 as soon as the schema spine is on rebuild/trunk; then the Phase 5 money core. Money correctness is the priority over speed. Follow 50 §6 and §7. Keep docs/codex/tracks/E.md current. Do not edit PROGRESS.md. Never use live keys. Work continuously through the queue.

**Track C (`/Users/sammooney/Sport-c-adapters`, GPT-6 Luna):**
> You are Track C (adapters) of the Athlentry rebuild. Read AGENTS.md, docs/codex/50-PARALLEL-PLAN.md (fully), docs/codex/15-SPEC-CLARIFICATIONS.md, docs/codex/01-ARCHITECTURE.md §7–§9, Phase 1 tasks 11–12 in docs/codex/10-PHASES-FOUNDATION.md and Phase 10 task 1 in docs/codex/12-PHASES-EXPANSION.md for the provider requirements. Stripe belongs to Track E, not you. You own only the paths listed for Track C in 50 §2. Execute the Track C queue in 50 §4 in order, following 50 §6 and §7. Keep docs/codex/tracks/C.md current. Do not edit PROGRESS.md. Never use live keys or send real messages. Work continuously through the queue.

**Track D (`/Users/sammooney/Sport-d-design`, GPT-6 Luna):**
> You are Track D (design system) of the Athlentry rebuild. Read AGENTS.md, docs/codex/50-PARALLEL-PLAN.md (fully), docs/codex/01-ARCHITECTURE.md §11 and §11a, docs/codex/05-UX-AND-NAVIGATION.md, and the legacy styles/components in legacy/web. The existing design system must be preserved exactly. You own only the paths listed for Track D in 50 §2. Execute the Track D queue in 50 §4 in order, publishing primitives early, following 50 §6 and §7. Keep docs/codex/tracks/D.md current. Do not edit PROGRESS.md. Work continuously through the queue.

**After S1 (all on GPT-6 Luna):** restart Track A on Luna with: "You are Track A (core + integrator), continuing after Sol checkpoint S1. Read AGENTS.md, docs/codex/50-PARALLEL-PLAN.md, docs/codex/60-LUNA-PLAYBOOK.md, docs/codex/tracks/A.md and PROGRESS.md, then continue the Track A queue after S1 and the integrator duties in 50 §6. Follow the playbook exactly; call existing services and shared policies instead of re-implementing them." Then start F, G, H with the template below (add "Read docs/codex/60-LUNA-PLAYBOOK.md and follow it exactly; call shared/src/policies and existing services instead of re-implementing rules.").

**Wave 2 tracks F, G, H** — started by the owner after S1. Prompt template:
> You are Track <X> (<name>) of the Athlentry rebuild. Read AGENTS.md, docs/codex/50-PARALLEL-PLAN.md (fully), docs/codex/15-SPEC-CLARIFICATIONS.md, and the spec for Phase(s) <N> plus the data-model, permissions and algorithm sections they cite. You own only the paths listed for Track <X> in 50 §2 and migration range <range>. Implement Phase(s) <N> to their acceptance criteria against the schema spine and test factories on rebuild/trunk, following 50 §6 and §7. Keep docs/codex/tracks/<X>.md current. Do not edit PROGRESS.md. Work continuously.
