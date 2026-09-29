DO $migration$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'calendar_feeds'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%account_id IS NOT NULL%'
      AND pg_get_constraintdef(oid) LIKE '%team_season_id IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE calendar_feeds DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$migration$;

ALTER TABLE calendar_feeds
  ADD CONSTRAINT calendar_feeds_scope_shape_check CHECK (
    (
      scope->>'type' = 'account'
      AND account_id IS NOT NULL
      AND team_season_id IS NULL
    )
    OR (
      scope->>'type' = 'team'
      AND account_id IS NULL
      AND team_season_id IS NOT NULL
      AND scope->>'id' = team_season_id::text
    )
    OR (
      scope->>'type' = 'facility'
      AND account_id IS NULL
      AND team_season_id IS NULL
      AND scope->>'id' IS NOT NULL
    )
  );
