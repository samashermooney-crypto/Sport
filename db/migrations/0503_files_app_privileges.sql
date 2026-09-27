-- Migrations may be run by a superuser whose default privileges differ from
-- athlentry_admin. Grant the app role the table operations allowed by files RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON files TO athlentry_app;
