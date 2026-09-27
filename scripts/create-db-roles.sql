-- Run as a PostgreSQL superuser once for each application database. Keep all
-- password values in the operator environment; never pass them as CLI arguments.
\set ON_ERROR_STOP on
\getenv app_password ATHLENTRY_APP_ROLE_PASSWORD
\getenv admin_password ATHLENTRY_ADMIN_ROLE_PASSWORD
\getenv backup_password ATHLENTRY_BACKUP_ROLE_PASSWORD

\if :{?app_password}
\else
  \echo 'Set ATHLENTRY_APP_ROLE_PASSWORD before running this file.'
  \quit 3
\endif
\if :{?admin_password}
\else
  \echo 'Set ATHLENTRY_ADMIN_ROLE_PASSWORD before running this file.'
  \quit 3
\endif
\if :{?backup_password}
\else
  \echo 'Set ATHLENTRY_BACKUP_ROLE_PASSWORD before running this file.'
  \quit 3
\endif

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'athlentry_admin') THEN
    CREATE ROLE athlentry_admin LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'athlentry_app') THEN
    CREATE ROLE athlentry_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'athlentry_backup') THEN
    CREATE ROLE athlentry_backup LOGIN;
  END IF;
END
$roles$;

ALTER ROLE athlentry_admin WITH LOGIN CREATEDB BYPASSRLS NOINHERIT
  NOSUPERUSER NOCREATEROLE NOREPLICATION PASSWORD :'admin_password';
ALTER ROLE athlentry_app WITH LOGIN NOCREATEDB NOBYPASSRLS NOINHERIT
  NOSUPERUSER NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
ALTER ROLE athlentry_backup WITH LOGIN NOCREATEDB BYPASSRLS NOINHERIT
  NOSUPERUSER NOCREATEROLE NOREPLICATION PASSWORD :'backup_password';

SELECT current_database() AS role_database \gset
GRANT CONNECT ON DATABASE :"role_database" TO athlentry_app;
GRANT CONNECT ON DATABASE :"role_database" TO athlentry_backup;
GRANT USAGE ON SCHEMA public TO athlentry_app;
GRANT USAGE ON SCHEMA public TO athlentry_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO athlentry_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO athlentry_backup;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO athlentry_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO athlentry_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athlentry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO athlentry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public
  GRANT SELECT ON TABLES TO athlentry_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO athlentry_backup;

DO $pgboss_grants$
BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'pgboss') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO athlentry_backup';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO athlentry_backup';
    EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO athlentry_backup';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA pgboss GRANT SELECT ON TABLES TO athlentry_backup';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA pgboss GRANT SELECT ON SEQUENCES TO athlentry_backup';
  END IF;
END
$pgboss_grants$;
