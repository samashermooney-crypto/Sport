# Phase 16 load-test results — 2026-09-27

Status: **acceptance not run; blocked on parallel-track contracts and the load seed.** The `grafana/k6:latest` runner was pulled and verified as k6 v2.3.0 on 2026-09-27. The checkout has no synthetic load fixture files or reference-size deployment, and `db/seeds/index.ts` supports only `e2e` and `demo`, not the required 100-organization `load` profile. No performance result is inferred from local typechecks, unit tests or the migrated database.

| Scenario                                                          | Status  | Outstanding input                                                                                            |
| ----------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| Registration-open: 2,000 families / 10 capacity-limited offerings | Not run | Track E stable checkout route, synthetic fixture and capacity-counter verification query; Track A load seed. |
| Steady reads: 200 requests/second for 10 minutes                  | Not run | Load-seeded org/people/registration/attendance data and synthetic console/portal sessions.                   |
| Game day: 500 coaches plus 5,000 public reads/minute              | Not run | Stable attendance/score and public schedule/standings routes with fake fixtures; load seed.                  |
| Campaign fan-out: 20,000 recipients                               | Not run | Track A load seed with a synthetic email-eligible audience and reference-size preview deployment.            |

The attendance game-day and public standings/schedule routes are present, but no 500-coach or public-read fixture set is available. The checkout/registration-open path and family fixtures are still pending Track E. The campaign contract is available: POST the send route with the current expected version and preview counts, then poll the stats route's per-channel/per-status delivery counts. There is no 20,000-recipient synthetic campaign fixture or reference-size deployment yet. No k6 requests were sent without these fixtures.

Acceptance requires four k6 summaries under this directory, threshold results against the 2-web / 1-worker / 2-vCPU-8-GB Postgres reference shape, and a separate registration no-oversell count check. See `perf/README.md` and `docs/codex/13-PHASE-PRODUCTION.md §2`.
