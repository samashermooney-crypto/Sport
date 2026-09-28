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

The full acceptance review remains pending the Track A `load` seed (100 organizations, 150,000 people, 400,000 registrations and 2,000,000 attendance rows). No index request has been filed because the isolated database lacks matching rows and tenant cardinality.

Once the profile is available:

1. Run the four preview load scenarios and collect `pg_stat_statements` deltas for that interval, resetting only in the disposable load database.
2. Select the 30 highest-total-time normalized statements that belong to hot application paths. Preserve parameter types and tenant IDs in the isolated environment; redact values in committed reports.
3. Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with representative tenant and cursor values. Review rows estimated versus actual, loops, buffer reads, sort spills, index conditions and RLS filters.
4. File a concrete index request in the owning track's `Requests from OPS` section, including the redacted query shape, plan symptom, candidate index columns/order/predicate and before/after plan evidence. Do not add indexes outside OPS ownership.
5. Re-run the affected scenario and query after the owner adds the index; report write-cost and storage trade-offs as well as read latency.

Initial code-path candidates to capture after seeding are: `capacity_holds` and `capacity_counters` reservation/expiry paths (Track E); paginated roster, attendance and public schedule/standings reads (their module owners); and `message_deliveries` campaign recipient selection plus campaign counts (Track H). These are capture targets, not index findings.
