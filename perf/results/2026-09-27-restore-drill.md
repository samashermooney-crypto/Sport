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

The drill was rerun after trunk migrations `0503` and `0900`–`0903` were applied to the isolated database; role grants were refreshed first. Post-run query confirmed there were zero databases matching `athlentry_ops_restore_%`. The counts matched the source snapshot exactly. This validates encrypted dump/restore behavior and cleanup on the isolated schema; it is not evidence for full-size load performance or production recovery-time targets.
