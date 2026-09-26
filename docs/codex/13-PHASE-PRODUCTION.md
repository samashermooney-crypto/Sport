# 13 — Phase 16: Production Hardening and Launch Gate

This phase makes the platform operable by strangers with real children's data and real money. Nothing here is optional.

## 1. Security

1. Threat model document `docs/security/THREAT-MODEL.md` (STRIDE per surface: auth, tenancy, payments/webhooks, files, messaging, public site, platform console, federation, AI assist) with mitigations mapped to code/tests.
2. Automated checks: tenancy fuzz test (for every GET/PATCH/DELETE route with an `:id`, request another org's id → 404), permission matrix test (`04 §1`) over all routes, IDOR test for portal (guardian A cannot read guardian B's child by id), CSRF test (missing header/origin rejected), rate-limit tests, webhook signature tests, upload type/size bypass tests, SSRF review (no user-controlled server-side fetches except the optional geocoder with allow-listed host), SQL injection impossible by construction (Kysely; grep CI check forbidding `sql.raw` with interpolated input), stored XSS test for rich text/website/chat.
3. `npm audit` clean (no high/critical), `knip` clean, secret scanning in CI (`gitleaks`).
4. Security headers verified by test (CSP, HSTS, frame options, referrer policy, permissions policy).
5. Session security: cookie flags verified, session fixation prevented (rotate on sign-in/MFA/step-up), logout invalidates server-side.
6. Admin MFA enforcement verified; platform staff MFA mandatory; impersonation audited and time-limited.
7. Encryption key rotation script tested on seed data.
8. Write `docs/security/INCIDENT-RESPONSE.md` (detection, containment, notification obligations placeholder for lawyer review, contacts) and `docs/security/VULNERABILITY-DISCLOSURE.md` + `/.well-known/security.txt`.

## 2. Performance and scale

1. Load test scripts with k6 in `perf/`: (a) registration-open spike: 2,000 families starting checkout within 10 minutes for 10 offerings with limited capacity; (b) steady state 200 req/s mixed console/portal reads; (c) Saturday game day: 500 concurrent coaches submitting attendance/scores + 5,000 public standings/schedule reads per minute; (d) campaign fan-out of 20,000 recipients.
2. Targets on the reference deployment size (2 vCPU / 4 GB web ×2, worker ×1, Postgres 2 vCPU / 8 GB): p95 API latency < 300 ms and p99 < 1 s for (b); zero errors and zero oversell in (a); (c) p95 < 500 ms; (d) completes within 15 minutes with provider fakes.
3. Query review: `EXPLAIN ANALYZE` of the 30 heaviest queries on the `load` seed profile (100 orgs, 150k people, 400k registrations, 2M attendance rows); add indexes; no sequential scans on tenant tables > 10k rows in hot paths.
4. Pagination everywhere; no endpoint returns unbounded lists.
5. Web: bundle budgets (`01 §11`) enforced; Core Web Vitals on portal Home and checkout (Lighthouse mobile Performance ≥ 85).

## 3. Accessibility and internationalization

1. axe on every Playwright page (already required) plus a manual keyboard-only pass script documented in `docs/qa/ACCESSIBILITY.md` covering the 25 journeys in `30 §3`.
2. Screen-reader labels for charts (data tables as alternatives), calendar, drag-and-drop boards (keyboard alternatives verified).
3. Spanish completeness check: CI fails if any `en` key in portal/site/auth/email namespaces lacks an `es` value.
4. Accessibility statement page on the marketing site and each org site footer.

## 4. Reliability and operations

1. Dockerfile (multi-stage, non-root user, `node:24-slim`, healthcheck), `render.yaml` blueprint (web ×2, worker ×1, env groups), zero-downtime deploy notes: migrations are backward-compatible for one release (expand/contract), run as a pre-deploy job.
2. Backups: document managed Postgres PITR (retention ≥ 14 days) + nightly logical dump to separate storage (`scripts/backup.ts` with encryption), object storage versioning; **restore drill** script restores into a scratch database and runs verification queries — run it and record results.
3. Observability: Sentry wired, structured logs, `/readyz`, worker heartbeat alerts, queue depth and failed-job alerts, webhook-silence alert (no Stripe webhook in 24 h while charges occurred), payment failure rate alert, email bounce rate alert. `docs/ops/RUNBOOK.md` with procedures: failed deploy rollback, stuck jobs, webhook backlog replay (`scripts/replay-stripe-events.ts`), provider outage (email/SMS), database restore, key rotation, suspending an abusive org, handling a data-subject request, responding to a dispute spike.
4. Status: a simple platform status page route reading health metrics (public, no sensitive info).
5. Feature flags for risky launches (AI assist, federation, class mode) default on for seed/demo, owner-controlled in platform console.
6. Email deliverability checklist (SPF/DKIM/DMARC for sending domain, List-Unsubscribe header, bounce handling) in `40`.
7. Operator tooling referenced by `40-OPERATOR-CHECKLIST.md` must exist and be tested: `npm run keys:generate` (data-encryption keys JSON), `npm run keys:vapid`, `scripts/create-db-roles.sql`, `scripts/create-platform-admin.ts`, `scripts/stripe-smoke.ts`, `scripts/backup.ts`, `scripts/restore-drill.ts`, `scripts/replay-stripe-events.ts`, `scripts/rotate-encryption-key.ts`, and docs `docs/ENVIRONMENT.md`, `docs/ops/RUNBOOK.md`, `docs/ops/CUSTOM-DOMAINS.md`, `docs/help/import-presets.md`.

## 5. Legal and trust surfaces (drafts; lawyer review is an operator step)

1. Marketing site pages: Terms of Service (draft), Privacy Policy (draft, covering children's data, COPPA, FERPA-not-applicable note, data processors list: Stripe, Resend, Twilio, storage, hosting, Sentry, optional Anthropic), Data Processing Addendum (draft for orgs), Acceptable Use, Subprocessors, Security overview, Accessibility statement. Each draft is watermarked "DRAFT — requires legal review" until the owner flips `LEGAL_DOCS_APPROVED=true`; production start refuses without it (documented in `40`).
2. Org-level refund policy editor with a neutral template; must be accepted at checkout (consent record).
3. Waiver templates remain drafts that orgs must edit; the product states clearly that waivers are the org's responsibility.

## 6. Cleanup and truthfulness

1. Delete `legacy/` (history remains in git). Remove unused dependencies (`knip`).
2. Update landing page copy (`web/src/marketing`) to describe only implemented features; remove any claims of partnerships or integrations that do not exist; include pricing page reading plan data.
3. `README.md`: product overview, architecture summary, local setup, commands, environment, deployment reference, limitations (D18 list), links to docs.
4. Final `PROGRESS.md` with evidence per phase and `40-OPERATOR-CHECKLIST.md` complete.

## 7. Launch gate (all must be true)

- [ ] All phases' acceptance criteria met with evidence links in `PROGRESS.md`.
- [ ] CI green on `main` including e2e on Chromium desktop and WebKit iPhone viewport.
- [ ] Coverage: `shared/` ≥ 95% lines; `server/src/modules/finance`, `registration`, `checkout`, `compliance`, `auth` ≥ 90% lines; overall server ≥ 85%.
- [ ] Load tests meet §2 targets (results committed in `perf/results/`).
- [ ] Restore drill passed (log committed).
- [ ] Security checks §1 pass; threat model complete.
- [ ] Lighthouse targets met (Phase 14, §2.5).
- [ ] Design parity suite passes; the product still uses the original design system (`01 §11a`), with any accessibility-driven adjustments listed in `DECISIONS.md`.
- [ ] No `TODO`/`FIXME`/`console.log` in `server/src`, `web/src`, `shared/src` (CI grep).
- [ ] Every navigation item and button in console, portal, site and platform is reachable by an e2e test or an explicit smoke test that clicks it (route crawler test that visits every route for each role and fails on 404/500/unhandled error/empty ErrorState).
- [ ] `40-OPERATOR-CHECKLIST.md` contains only human-only steps.
