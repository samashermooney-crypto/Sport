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
