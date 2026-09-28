# Phase 16 load-test results — 2026-09-27

Status: **acceptance not run; blocked on parallel-track contracts and the load seed.** The `grafana/k6:latest` runner was pulled and verified as k6 v2.3.0 on 2026-09-27. The checkout has no synthetic load fixture files or reference-size deployment, and `db/seeds/index.ts` supports only `e2e` and `demo`, not the required 100-organization `load` profile. No performance result is inferred from local typechecks, unit tests or the migrated database.

Script validation: `k6 inspect` loaded all four scenario configurations with disposable empty fixture files in a read-only, network-isolated container. No requests were sent; this confirms script parsing and configured thresholds only, not load-test acceptance.

| Scenario                                                          | Status  | Outstanding input                                                                                            |
| ----------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| Registration-open: 2,000 families / 10 capacity-limited offerings | Not run | Track E stable checkout route, synthetic fixture and capacity-counter verification query; Track A load seed. |
| Steady reads: 200 requests/second for 10 minutes                  | Not run | Load-seeded org/people/registration/attendance data and synthetic console/portal sessions.                   |
| Game day: 500 coaches plus 5,000 public reads/minute              | Not run | Stable attendance/score and public schedule/standings routes with fake fixtures; load seed.                  |
| Campaign fan-out: 20,000 recipients                               | Not run | Track A load seed with a synthetic email-eligible audience and reference-size preview deployment.            |

The attendance game-day and public standings/schedule routes are present, but no 500-coach or public-read fixture set is available. The checkout/registration-open path and family fixtures are still pending Track E. The campaign contract is available: POST the send route with the current expected version and preview counts, then poll the stats route's per-channel/per-status delivery counts. There is no 20,000-recipient synthetic campaign fixture or reference-size deployment yet. No k6 requests were sent without these fixtures.

Acceptance requires four k6 summaries under this directory, threshold results against the 2-web / 1-worker / 2-vCPU-8-GB Postgres reference shape, and a separate registration no-oversell count check. See `perf/README.md` and `docs/codex/13-PHASE-PRODUCTION.md §2`.

## Latest OPS run — 2026-09-27 (local)

The K `load` profile was run against isolated OPS Postgres after merging OPS through `1a82760e`. It applied K migrations 8500–8502, then stopped before completing the first load organization: `team_staff` seed SQL inferred `team_map.team_index` as text while `generated.team_index` is integer (`operator does not exist: integer = text`). The failure is filed in `docs/codex/tracks/OPS.md`; OPS did not edit K-owned seed code. A current-schema restore drill then passed at 178 migrations / highest version 8502. Its verified aggregate counts were 108 organizations, 2,288 people, 1,156 registrations, 0 attendance, 8 invoices, 0 payments and 32 audit rows. These counts are far below the required 100-org / 150k-person / 400k-registration / 2M-attendance profile and do not support load acceptance. No k6 HTTP requests were sent.
