# Restore drill — 2026-09-27

Environment: isolated local Compose project `athlentry_ops` with `PORT_OFFSET=1400`; source database `athlentry_dev`; only one synthetic organization row was added to prove a tenant record survived. No real family data or provider credentials were used. The backup encryption key and role passwords were randomly generated in owner-only `/tmp` files and are not retained in this repository.

Command: `node --import tsx scripts/restore-drill.ts` with `RESTORE_SOURCE_URL` set to the read-only `athlentry_backup` role, `RESTORE_ADMIN_URL` set to the local maintenance database, and `PGTOOLS_DOCKER_COMPOSE=1`.

```text
restore_drill: passed
scratch_database: athlentry_ops_restore_1790530042967_6da1060a
scratch_database_cleanup: passed
schema_migrations: 117
latest_migration: 4006
verified_row_counts: organizations=1, people=0, registrations=0, attendance=0, invoices=0, payments=0, audit_log=0
encryption_authentication: passed
```

## Current trunk rerun

After syncing current trunk and applying migrations through `6002` to the isolated database, the drill was rerun with a newly generated ephemeral encryption key. The source still contained only the one synthetic organization. The backup/restore counts matched exactly; a post-run query confirmed zero databases matching `athlentry_ops_restore_%`.

```text
restore_drill: passed
scratch_database: athlentry_ops_restore_1790539820161_696f0d8c
scratch_database_cleanup: passed
schema_migrations: 145
latest_migration: 6002
verified_row_counts: organizations=1, people=0, registrations=0, attendance=0, invoices=0, payments=0, audit_log=0
encryption_authentication: passed
```

This validates encrypted dump/restore behavior and cleanup on the isolated schema; it is not evidence for full-size load performance or production recovery-time targets.

## OPS isolated-stack rerun after Phase 11

After syncing the current trunk through Phase 11, the isolated `athlentry_ops` stack at `PORT_OFFSET=1400` was migrated through `8010_phase11_foreign_key_indexes.sql`. The source was `athlentry_test` using the read-only backup role; scratch creation used the local `postgres` maintenance role. A new one-run encryption key was generated in memory and was not persisted.

```text
restore_drill: passed
scratch_database: athlentry_ops_restore_1790544702633_14949a18
scratch_database_cleanup: passed
schema_migrations: 156
latest_migration: 8010
verified_row_counts: organizations=0, people=0, registrations=0, attendance=0, invoices=0, payments=0, audit_log=0
encryption_authentication: passed
```

This verifies restore behavior against the latest merged schema with the least-privilege backup role. The scratch database was removed before the command completed.

## Nonzero latest-schema rerun — 2026-09-27

To verify restored data as well as the schema, one synthetic organization row was inserted into isolated `athlentry_test` with the admin role. Tenant-table counts are collected inside `withOrg` transactions for each organization; only the migration ledger and global organization directory are read outside that helper. The drill ran with `athlentry_backup` as its source, a one-run AES-256 key generated in memory, and the local `postgres` maintenance role. It removed its scratch database, and the synthetic source row was then deleted.

```text
restore_drill: passed
scratch_database: athlentry_ops_restore_1790549270296_d71603c5
scratch_database_cleanup: passed
schema_migrations: 156
latest_migration: 8010
verified_row_counts: organizations=1, people=0, registrations=0, attendance=0, invoices=0, payments=0, audit_log=0
encryption_authentication: passed
synthetic_restore_fixture_cleanup: passed
```

No family data or credentials were used or persisted.

## OPS sync after registration and Phase 3 migrations — 2026-09-27

After syncing trunk through `2c52eb47` and applying migrations through 1063 to the isolated `athlentry_ops` stack, the encrypted restore drill was rerun against `athlentry_test`. It verified all row-count checks against the source and restored scratch database. The ledger contained 168 migrations; the highest numeric version was 8010 (the merged migration streams include lower-numbered Phase 3 and registration versions).

```text
restore_drill: passed
scratch_database: athlentry_ops_restore_1790558137549_abb4f000
scratch_database_cleanup: passed (post-run query found 0 athlentry_ops_restore_% databases)
schema_migrations: 168
highest_migration_version: 8010
verified_row_counts: organizations=0, people=0, registrations=0, attendance=0, invoices=0, payments=0, audit_log=0
encryption_authentication: passed
```

This verifies the latest synced schema and authenticated encrypted restore path. It does not provide full-size recovery-time evidence.

## Current-schema drill after K migrations — 2026-09-27 (local)

After the K `load` seed attempt applied migrations 8500–8502, the encrypted drill was run against the isolated `athlentry_ops` database using the read-only backup role and the local PostgreSQL maintenance role. A new AES-256 key was generated in memory for this run and was not saved.

```text
restore_drill: passed
scratch_database: athlentry_ops_restore_1790565156906_6456ae61
scratch_database_cleanup: passed
schema_migrations: 178
latest_migration: 8502
verified_row_counts: organizations=108, people=2288, registrations=1156, attendance=0, invoices=8, payments=0, audit_log=32
encryption_authentication: passed
```

The drill verified restored row counts and scratch cleanup. The seed had not produced representative load data; see `2026-09-27-load-tests.md` and the query review for limitations.
