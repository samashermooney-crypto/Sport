CREATE TABLE rate_limit_points (
  key varchar(255) PRIMARY KEY,
  points integer NOT NULL DEFAULT 0,
  expire bigint
);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_points TO athlentry_app;
