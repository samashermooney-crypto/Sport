-- Each team season starts with its own ledger so finance staff can assess fees
-- before any team income or expense has been posted.
INSERT INTO team_ledgers (org_id, team_season_id, created_by)
SELECT org_id, id, '0199a1c0-0000-7000-8000-000000000001'::uuid
FROM team_seasons
ON CONFLICT (org_id, team_season_id) DO NOTHING;

CREATE OR REPLACE FUNCTION create_team_season_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ledger_actor uuid := COALESCE(
    NULLIF(current_setting('app.actor_id', true), '')::uuid,
    '0199a1c0-0000-7000-8000-000000000001'::uuid
  );
BEGIN
  INSERT INTO team_ledgers (org_id, team_season_id, created_by)
  VALUES (NEW.org_id, NEW.id, ledger_actor)
  ON CONFLICT (org_id, team_season_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER team_seasons_create_ledger
AFTER INSERT ON team_seasons
FOR EACH ROW EXECUTE FUNCTION create_team_season_ledger();
