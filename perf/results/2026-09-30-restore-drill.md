# Restore drill — 2026-09-30 (launch-gate candidate)

Environment: isolated local Compose project `athlentry_gate` with `PORT_OFFSET=1600` (PostgreSQL 16.15), source database `athlentry_dev` migrated from empty through the current migration set and seeded with the deterministic `load` profile (`node --import tsx db/seeds/index.ts --profile load`). Synthetic data only; no real family data or provider credentials were used.

Roles were provisioned with the production script `scripts/create-db-roles.sql` (random role passwords supplied through the environment, not retained): `athlentry_app` without `BYPASSRLS`, `athlentry_admin`, and the read-only `athlentry_backup` role with `BYPASSRLS`, as documented in `docs/ops/RUNBOOK.md`. The backup encryption key was a freshly generated 32-byte key held only in the shell environment.

Command: `node --import tsx scripts/restore-drill.ts` with `RESTORE_SOURCE_URL` set to the `athlentry_backup` role, `RESTORE_ADMIN_URL` set to the cluster's `postgres` maintenance database, and `PGTOOLS_DOCKER_COMPOSE=1`.

```text
restore_drill: passed
scratch_database: athlentry_ops_restore_1790792789180_19351c00
scratch_database_cleanup: passed
schema_migrations: 195
latest_migration: 8502
verified_row_counts: organizations=108, people=152288, registrations=401156, attendance=2000000, invoices=8, payments=0, audit_log=32
encryption_authentication: passed
real 31.52
```

The encrypted (AES-256-GCM) logical dump of the full load-profile dataset was restored into a new scratch database, the migration ledger and row counts matched the source snapshot exactly, the ciphertext authentication tag verified, and the scratch database was removed.

Finding recorded during the drill: a backup role granted only `pg_read_all_data` fails on RLS-protected tables (`query would be affected by row-level security policy`); the runbook's `BYPASSRLS` requirement for `athlentry_backup` is therefore mandatory, and `scripts/create-db-roles.sql` provisions it correctly.

This is local recovery evidence for the current schema at load-profile scale. Managed PostgreSQL point-in-time recovery and production recovery-time objectives remain operator responsibilities (`docs/codex/40-OPERATOR-CHECKLIST.md`).
