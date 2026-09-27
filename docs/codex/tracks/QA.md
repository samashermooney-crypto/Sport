# Track QA — acceptance audit

Status: working
Branch: `track/qa`

## Ready for integration ranges

- None yet. Branch was synced from `rebuild/trunk` at `2ac58d6`; crawler and QA-authored journey browser verification remain blocked.

## Requests to other tracks

- C — QA-SEC-001: publish permission/resource/scope metadata and tenancy fixture contracts for every API operation; the route-authorization, permission-matrix, and tenancy-fuzz e2e checks still use `test.fixme`, and the permission matrix has no operation rows. Details and reproduction are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-002: enable the security-header browser check; it remains `test.fixme` even though C reports the middleware is mounted. Details are in `docs/codex/qa/DEFECTS.md`.
- C — QA-SEC-003: add Gitleaks to CI; the current workflow has no secret scan. Details are in `docs/codex/qa/DEFECTS.md`.
- H — QA-ACC-021: extend the communications browser journey through quiet-hour deferral and tokenized unsubscribe. Details are in `docs/codex/qa/DEFECTS.md`.
- I — release or move the active `athlentry_i` stack from the QA-required `PORT_OFFSET=1500`; its Postgres, Mailpit, and Stripe mock mappings collide with ports `6932`, `2525/9525`, and `13611`. Do not stop the other track's containers from QA.

## Blocked on

- Chromium/WebKit QA runs need Postgres at `127.0.0.1:6932`; Track I currently owns that port. Docker startup fails with `Bind for 127.0.0.1:6932 failed: port is already allocated`. Track I also owns Mailpit and Stripe-mock host ports for the same offset. Do not stop those services; wait for the owner to use the assigned Track I offset or release its stack.

## Progress

- Merged `rebuild/trunk` (`2ac58d6`) into `track/qa` (`0589556`), bringing in Track A medical and import flows. The guardian journey now checks saved medical values after reload and the guardian IDOR journey asserts foreign medical access returns 404.
- Reviewed WIP `7a39c59`; replaced the fixed 50-route/5-role crawl with rendered-navigation discovery, per-route HTTP/API/request/error checks, explicit queue completion, axe, and fixtures for every organization role, guardian/self, and all platform roles.
- Added the 27-journey audit inventory, a 2,000-person import preview/commit/rollback journey, and a SafeSport guardian-inclusion browser journey. Guardian medical save/reload and cross-guardian medical 404 checks are also added. After installing the merged lockfile dependencies, `npm run typecheck`, `npm run lint`, and `git diff --check` pass on the post-sync tree.
- Targeted Chromium runs remain unverified: the latest `heavy.sh` attempt exited before `webServer` started; current Docker inspection confirms Track I owns QA's Postgres, Mailpit and Stripe mock ports. No other track containers were stopped.
- No range is ready for integration until the required Chromium merge gate can run.
