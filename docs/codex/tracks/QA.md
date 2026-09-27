# Track QA — acceptance audit

Status: working
Branch: `track/qa`

## Ready for integration ranges

- None yet. Five QA commits remain ahead of `rebuild/trunk`; sync merge `c850d53` includes trunk `d038556` and passes typecheck/lint, but the required Chromium run cannot start while Track I owns QA's prescribed ports.

## Requests to other tracks

- C — QA-SEC-001: publish permission/resource/scope metadata and tenancy fixture contracts for every API operation; the route-authorization, permission-matrix, and tenancy-fuzz e2e checks still use `test.fixme`, and the permission matrix has no operation rows. Details and reproduction are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-002: enable the security-header browser check; it remains `test.fixme` even though C reports the middleware is mounted. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-003: add Gitleaks to CI; the current workflow has no secret scan. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-004: validate Web Push subscription destinations before the transport call; loopback and internal destinations currently reach `sendNotification`, and the SSRF regression is `test.fixme`. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-PERF-001: reduce the gzipped app bundle to the configured 200 KB budget; `npm run size` measures 395.62 KB and exits 1. Details are in `docs/codex/qa/DEFECTS.md`.
- G — QA-ACC-015–020: add the missing Phase 8/9 browser flows and complete the partial rainout and offline game-day flows; details and exact gaps are in `docs/codex/qa/DEFECTS.md`.
- H — QA-ACC-021: extend the communications browser journey through quiet-hour deferral and tokenized unsubscribe. Details are in `docs/codex/qa/DEFECTS.md`.
- I — QA-ACC-024: extend the academy browser flow to cover monthly tuition/proration and level promotion in addition to its current make-up booking and attendance coverage. Details are in `docs/codex/qa/DEFECTS.md`.
- I — release or move the active `athlentry_i` stack from the QA-required `PORT_OFFSET=1500`; its Postgres, Mailpit, and Stripe mock mappings collide with ports `6932`, `2525/9525`, and `13611`. Do not stop the other track's containers from QA.

## Blocked on

- Chromium/WebKit QA runs need the ports derived from `PORT_OFFSET=1500`; Track I currently owns Postgres `6932`, Mailpit SMTP/API `2525/9525`, and Stripe mock `13611`. The latest startup failed with `Bind for 127.0.0.1:13611 failed: port is already allocated`. Do not stop those services; retry after the collision is resolved.

## Progress

- Synced `rebuild/trunk` through `d038556` into `track/qa`, resolving the A track-note and guardian-IDOR conflicts while retaining both owners' requests and asserting both 404 and absence of the foreign allergy value.
- Reviewed WIP `7a39c59`; replaced the fixed 50-route/5-role crawl with rendered-navigation discovery, per-route HTTP/API/request/error checks, explicit queue completion, axe, and fixtures for every organization role, guardian/self, and all platform roles.
- Security review confirmed the skipped Web Push SSRF regression matches an unvalidated transport call; QA-SEC-004 records the synthetic reproduction and Track C request.
- Added the 27-journey audit inventory, a 2,000-person import preview/commit/rollback journey, and a SafeSport guardian-inclusion browser journey. Guardian medical save/reload and cross-guardian medical 404 checks are also added. On the post-sync tree, `npm run typecheck`, `npm run lint`, and `git diff --check` pass.
- Targeted Chromium journeys and crawler remain unverified: `heavy.sh` exited before `webServer` started, and direct QA stack startup confirmed Track I owns all ports for the required offset. No other track containers were stopped.
- No range is ready for integration until the required Chromium merge gate can run.
