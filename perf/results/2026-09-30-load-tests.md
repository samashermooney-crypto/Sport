# Phase 16 load tests — 2026-09-30

Environment: isolated local Compose stack (`athlentry_gate`, PostgreSQL 16) seeded with the `load` profile (100 organizations, ~152k people, ~401k registrations, 2M attendance rows). One API process and one worker on the owner's Mac (the reference deployment in `13 §2` runs two web instances, so these are conservative). k6 v2.3.0 native, `K6_TARGET_ENV=isolated-preview`, `DELIVERY_MODE=preview` (fake/Mailpit delivery, no Stripe live keys). Synthetic fixtures were generated locally from the load seed and never committed.

| Scenario | Target (`13 §2`) | Result | Status |
|---|---|---|---|
| (a) Registration open — 2,000 families, 10 offerings × 100 places | zero errors, zero oversell | 2,000 requests, 0 unexpected responses, 0 dropped; 1,000 accepted + 1,000 expected capacity 409s; p95 48.8 ms, p99 55.7 ms; each offering exactly 100/100 held | **Pass** |
| (b) Steady reads — 200 req/s mixed console/portal for 10 min | p95 < 300 ms, p99 < 1 s | 120,000 requests, 0 errors, 0 dropped; p95 24.6 ms, max 153 ms | **Pass** |
| (c) Game day — 500 coaches (attendance + score) + 5,000 public reads/min | p95 < 500 ms | 50,932 requests, 0 errors; p95 34 ms, p99 1.8 s; 68 public-read iterations dropped during the simultaneous 500-coach burst | **Target met; script's zero-dropped threshold not met on one web process** |
| (d) Campaign fan-out — 20,000 email recipients | complete within 15 min | 20,000 delivered in 432 s, 0 failures | **Pass** |

## Defects found and fixed by these runs

- Family checkout failed for every admin-created program (missing program/division capacity counters) — migration 8503, DEC-145.
- Expired checkout holds were never released, so abandoned carts consumed capacity permanently — `checkout.release-expired-holds`, DEC-149.
- New families could not register (no self-service child creation; org guard blocked unlinked accounts) — DEC-150.
- Email-only campaigns could not be sent (confirm-count schema) and delivery stats returned 400; sends blocked the request for >60 s; drain was sequential.
- Public standings read every historical snapshot; database pool fixed at pg's 10; standings recomputed once per result during bursts (DEC-151); sessions resolved three times per request.

## Open follow-ups

- Game-day burst: remaining p99 latency during a 500-simultaneous-coach burst is API CPU on a single process; verify on the two-instance reference deployment before launch.
- The per-org operational metrics poll runs every 30 s plus a 1-minute cron (duplicate); consolidate before large tenant counts.
- EXPLAIN review of the 30 heaviest statements (`13 §2.3`) was not completed in this session; `pg_stat_statements` captures for (a) and (c) showed no statement above 35 ms max after the fixes.
