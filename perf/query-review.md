# Heavy-query review

The Phase 16 `EXPLAIN (ANALYZE, BUFFERS)` review is pending the Track A `load` seed (100 organizations, 150,000 people, 400,000 registrations and 2,000,000 attendance rows). The current local database has only migration and sport-template seed data; plans collected from it would not represent tenant selectivity or production cardinality. No index is being recommended from an unrepresentative plan.

Once the profile is available:

1. Run the four preview load scenarios and collect `pg_stat_statements` deltas for that interval, resetting only in the disposable load database.
2. Select the 30 highest-total-time normalized statements that belong to hot application paths. Preserve parameter types and tenant IDs in the isolated environment; redact values in committed reports.
3. Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with representative tenant and cursor values. Review rows estimated versus actual, loops, buffer reads, sort spills, index conditions and RLS filters.
4. File a concrete index request in the owning track's `Requests from OPS` section, including the redacted query shape, plan symptom, candidate index columns/order/predicate and before/after plan evidence. Do not add indexes outside OPS ownership.
5. Re-run the affected scenario and query after the owner adds the index; report write-cost and storage trade-offs as well as read latency.

Initial code-path candidates to capture after seeding are: `capacity_holds` and `capacity_counters` reservation/expiry paths (Track E); paginated roster, attendance and public schedule/standings reads (their module owners); and `message_deliveries` campaign recipient selection plus campaign counts (Track H). These are capture targets, not index findings.
