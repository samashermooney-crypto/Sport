# Track OPS — reliability and performance

Status: working
Ready for integration ranges: none yet
Requests to other tracks: C — wire `/readyz` and the public `/status` route through the generated registry, initialize the OPS structured logger and Sentry hooks in web and worker processes, and add package scripts `keys:generate` and `keys:vapid` (2026-09-27).
Requests to other tracks: C — wire periodic worker heartbeat, pg-boss queue-depth/failed-job, Stripe webhook-silence, payment-failure-rate, and email-bounce alert checks to the configured operational alert sink; remove `DATABASE_ADMIN_URL` from the web runtime after its pre-deploy use (2026-09-27).
Requests to other tracks: A — record DEC-082 in `docs/codex/DECISIONS.md` because that file is outside OPS ownership: encrypted AES-256-GCM backups with a scratch-only restore drill; status output contains only service state; Sentry events strip child/family PII (2026-09-27).
Requests to other tracks: A — build the documented `load` seed profile (100 organizations, 150k people, 400k registrations, 2M attendance rows) for the required k6 and EXPLAIN acceptance (2026-09-27).
Requests to other tracks: E — publish the family checkout load-test API contract, fake-adapter fixture and capacity-counter verification query (2026-09-27).
Requests to other tracks: H — confirm campaign enqueue/status endpoints and completion count for the 20,000-recipient fake-delivery load test (2026-09-27).
Blocked on: Track C `/readyz` and `/status` route/startup/alert wiring plus package script registration; Track A DEC-082 and load seed; Track E registration API and capacity-counter SQL; Track H campaign API/count contract; and an isolated reference-size preview for the steady-read/game-day acceptance. OPS-owned Docker/Render, backup/restore, role SQL, docs, operator scripts, observability primitives and k6 scenarios are implemented; the 117-migration restore drill and 16 focused tests pass.
