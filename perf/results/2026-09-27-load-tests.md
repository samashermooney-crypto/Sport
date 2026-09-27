# Phase 16 load-test results — 2026-09-27

Status: **not run; acceptance blocked on parallel-track contracts and the load seed.** No synthetic fixture files, preview endpoint contracts, k6 binary or reference-size deployment are available in this checkout yet. No performance result is inferred from local typechecks, unit tests or the small migrated database.

| Scenario                                                          | Status  | Outstanding input                                                                                            |
| ----------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| Registration-open: 2,000 families / 10 capacity-limited offerings | Not run | Track E stable checkout route, synthetic fixture and capacity-counter verification query; Track A load seed. |
| Steady reads: 200 requests/second for 10 minutes                  | Not run | Load-seeded org/people/registration/attendance data and synthetic console/portal sessions.                   |
| Game day: 500 coaches plus 5,000 public reads/minute              | Not run | Stable attendance/score and public schedule/standings routes with fake fixtures; load seed.                  |
| Campaign fan-out: 20,000 recipients                               | Not run | Track H enqueue/status routes and durable completion count using preview/fake delivery; load seed.           |

Acceptance requires four k6 summaries under this directory, threshold results against the 2-web / 1-worker / 2-vCPU-8-GB Postgres reference shape, and a separate registration no-oversell count check. See `perf/README.md` and `docs/codex/13-PHASE-PRODUCTION.md §2`.
