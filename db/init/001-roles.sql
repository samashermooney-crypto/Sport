CREATE ROLE athlentry_admin LOGIN CREATEDB BYPASSRLS NOINHERIT;
CREATE ROLE athlentry_app LOGIN NOINHERIT NOBYPASSRLS;
CREATE DATABASE athlentry_dev OWNER athlentry_admin;
CREATE DATABASE athlentry_test OWNER athlentry_admin;
CREATE DATABASE athlentry_e2e OWNER athlentry_admin;
GRANT CONNECT ON DATABASE athlentry_dev TO athlentry_app;
GRANT CONNECT ON DATABASE athlentry_test TO athlentry_app;
GRANT CONNECT ON DATABASE athlentry_e2e TO athlentry_app;
\connect athlentry_dev
GRANT USAGE ON SCHEMA public TO athlentry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athlentry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO athlentry_app;
\connect athlentry_e2e
GRANT USAGE ON SCHEMA public TO athlentry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athlentry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO athlentry_app;
\connect athlentry_test
GRANT USAGE ON SCHEMA public TO athlentry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athlentry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO athlentry_app;
