# Heavy-query review

## Current local review — 2026-09-27

Ran `perf/explain-current.mjs` against the isolated `athlentry_ops` app database role after trunk migrations through `6002` (145 recorded migrations), using `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for eight hot-path query shapes: capacity holds, capacity counters, attendance, active roster, public facility events, standings snapshots, recent email deliveries, and payment alert windows. The organization directory was populated, but each target query had zero matching sample rows. The selected indexes below therefore describe only the current empty-table plans; they are not representative findings, and no index request is justified from them.

| Query shape                     | Planner-selected index                                     | Actual rows | Finding                           |
| ------------------------------- | ---------------------------------------------------------- | ----------: | --------------------------------- |
| Capacity holds by reservation   | `capacity_holds_reservation_idx`                           |           0 | No selectivity or buffer evidence |
| Capacity counter by subject     | `capacity_counters_subject_idx`                            |           0 | No selectivity or buffer evidence |
| Attendance by event/status      | `attendance_event_status_idx`                              |           0 | No selectivity or buffer evidence |
| Active roster by event/person   | `roster_entries_active_person_idx`, `people_org_id_id_key` |           0 | Nested loop has no sample rows    |
| Public events by facility/space | `events_space_idx`                                         |           0 | No selectivity or buffer evidence |
| Standings snapshot by scope     | `standings_snapshots_scope_idx`                            |           0 | No selectivity or buffer evidence |
| Recent email deliveries         | `message_deliveries_recipient_idx`                         |           0 | No selectivity or buffer evidence |
| Payment alert window            | `payments_status_idx`                                      |           0 | No selectivity or buffer evidence |

The full acceptance review remains pending a successful K `load` profile (100 organizations, 150,000 people, 400,000 registrations and 2,000,000 attendance rows). The latest attempt failed in the `team_staff` seed mapping before load rows were committed. No index request has been filed because the isolated database lacks the required tenant cardinality and matching large-table rows.

Once the profile completes:

1. Run the four preview load scenarios and collect `pg_stat_statements` deltas for that interval, resetting only in the disposable load database.
2. Select the 30 highest-total-time normalized statements that belong to hot application paths. Preserve parameter types and tenant IDs in the isolated environment; redact values in committed reports.
3. Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with representative tenant and cursor values. Review rows estimated versus actual, loops, buffer reads, sort spills, index conditions and RLS filters.
4. File a concrete index request in the owning track's `Requests from OPS` section, including the redacted query shape, plan symptom, candidate index columns/order/predicate and before/after plan evidence. Do not add indexes outside OPS ownership.
5. Re-run the affected scenario and query after the owner adds the index; report write-cost and storage trade-offs as well as read latency.

Initial code-path candidates to capture after seeding are: `capacity_holds` and `capacity_counters` reservation/expiry paths (Track E); paginated roster, attendance and public schedule/standings reads (their module owners); and `message_deliveries` campaign recipient selection plus campaign counts (Track H). These are capture targets, not index findings.

## Latest synced schema review — 2026-09-27

Re-ran `perf/explain-current.mjs` with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against the isolated OPS app role after migrations through 1063 and 168 recorded migrations (highest numeric version 8010). The tenant directory was empty and all eight sample probes returned no rows. Each plan used the existing indexes below with zero actual rows; buffer reads were zero and shared hits were two or fewer. As before, these plans do not justify indexes. A successful K load profile and a representative preview are still required to collect the top 30 normalized statements and file evidence-backed requests.

| Query shape               | Existing selected index                                    | Sample rows | Read buffers |
| ------------------------- | ---------------------------------------------------------- | ----------: | -----------: |
| Checkout capacity holds   | `capacity_holds_reservation_idx`                           |           0 |            0 |
| Checkout capacity counter | `capacity_counters_subject_idx`                            |           0 |            0 |
| Game-day attendance       | `attendance_event_status_idx`                              |           0 |            0 |
| Game-day roster           | `roster_entries_active_person_idx`, `people_org_id_id_key` |           0 |            0 |
| Public facility schedule  | `events_space_idx`                                         |           0 |            0 |
| Public standings snapshot | `standings_snapshots_scope_idx`                            |           0 |            0 |
| Email delivery window     | `message_deliveries_recipient_idx`                         |           0 |            0 |
| Payment alert window      | `payments_status_idx`                                      |           0 |            0 |

## Current low-volume probe after K seed attempt — 2026-09-27 (local)

Re-ran the eight `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` probes on the isolated schema after migrations 8500–8502. The K load seed failed before inserting its first org's load rows; the source currently has only 2,288 people and 1,156 registrations, with no attendance. Two probes found small demo samples. These plans validate query/index wiring only and are not representative of the documented 100-org profile.

| Query shape               | Sample found | Plan and actual rows                                                                              | Actual time | Shared hits / reads |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------------- | ----------: | ------------------: |
| Checkout capacity holds   | No           | `capacity_holds_reservation_idx`, 0 rows                                                          |    0.006 ms |               2 / 0 |
| Checkout capacity counter | No           | `capacity_counters_subject_idx`, 0 rows                                                           |    0.007 ms |               1 / 0 |
| Game-day attendance       | No           | `attendance_event_status_idx`, 0 rows                                                             |    0.014 ms |               2 / 0 |
| Game-day roster           | Yes          | `roster_entries_active_person_idx` bitmap scan → nested loop with `people_org_id_id_key`, 14 rows |    0.179 ms |              57 / 0 |
| Public facility schedule  | Yes          | Sequential scan on `events`, 1 row                                                                |    0.046 ms |               5 / 0 |
| Public standings snapshot | No           | `standings_snapshots_scope_idx`, 0 rows                                                           |    0.008 ms |               2 / 0 |
| Email delivery window     | No           | `message_deliveries_recipient_idx`, 0 rows                                                        |    0.006 ms |               2 / 0 |
| Payment alert window      | No           | `payments_status_idx`, 0 rows                                                                     |    0.004 ms |               2 / 0 |

The event sequential scan touches one row in the small demo fixture and does not justify an index request. The query-statistics review for the top 30 normalized statements and hot-path checks on tables above 10,000 rows remain pending a successful load profile and representative deployment. No index request is justified from this low-volume run.
