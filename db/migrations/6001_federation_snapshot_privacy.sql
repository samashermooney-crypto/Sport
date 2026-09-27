-- Phase 13 follow-up: align agreement keys with the data model and protect
-- immutable roster payloads at the database boundary.

CREATE OR REPLACE FUNCTION federation_sharing_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad_key text;
  bad_value text;
BEGIN
  IF jsonb_typeof(NEW.data_sharing) <> 'object' THEN
    RAISE EXCEPTION 'data_sharing must be an object';
  END IF;
  SELECT k INTO bad_key FROM jsonb_object_keys(NEW.data_sharing) k
    WHERE k NOT IN ('rosters', 'compliance_status', 'team_entries', 'discipline')
    LIMIT 1;
  IF bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'data_sharing key % is not permitted', bad_key;
  END IF;
  SELECT k INTO bad_value FROM jsonb_each(NEW.data_sharing) e(k, v)
    WHERE jsonb_typeof(e.v) <> 'boolean' LIMIT 1;
  IF bad_value IS NOT NULL THEN
    RAISE EXCEPTION 'data_sharing values must be boolean';
  END IF;
  IF NEW.pending_data_sharing IS NOT NULL THEN
    IF jsonb_typeof(NEW.pending_data_sharing) <> 'object' THEN
      RAISE EXCEPTION 'pending_data_sharing must be an object';
    END IF;
    SELECT k INTO bad_key FROM jsonb_object_keys(NEW.pending_data_sharing) k
      WHERE k NOT IN ('rosters', 'compliance_status', 'team_entries', 'discipline')
      LIMIT 1;
    IF bad_key IS NOT NULL THEN
      RAISE EXCEPTION 'pending_data_sharing key % is not permitted', bad_key;
    END IF;
    SELECT k INTO bad_value FROM jsonb_each(NEW.pending_data_sharing) e(k, v)
      WHERE jsonb_typeof(e.v) <> 'boolean' LIMIT 1;
    IF bad_value IS NOT NULL THEN
      RAISE EXCEPTION 'pending_data_sharing values must be boolean';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE org_relationships
SET data_sharing =
  (data_sharing - 'complianceStatus' - 'teamEntries') ||
  CASE WHEN data_sharing ? 'complianceStatus'
    THEN jsonb_build_object('compliance_status', data_sharing->'complianceStatus')
    ELSE '{}'::jsonb END ||
  CASE WHEN data_sharing ? 'teamEntries'
    THEN jsonb_build_object('team_entries', data_sharing->'teamEntries')
    ELSE '{}'::jsonb END
WHERE data_sharing ? 'complianceStatus' OR data_sharing ? 'teamEntries';

UPDATE org_relationships
SET pending_data_sharing =
  (pending_data_sharing - 'complianceStatus' - 'teamEntries') ||
  CASE WHEN pending_data_sharing ? 'complianceStatus'
    THEN jsonb_build_object('compliance_status', pending_data_sharing->'complianceStatus')
    ELSE '{}'::jsonb END ||
  CASE WHEN pending_data_sharing ? 'teamEntries'
    THEN jsonb_build_object('team_entries', pending_data_sharing->'teamEntries')
    ELSE '{}'::jsonb END
WHERE pending_data_sharing ? 'complianceStatus' OR pending_data_sharing ? 'teamEntries';

CREATE FUNCTION federation_roster_snapshot_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.team_entry_id IS DISTINCT FROM OLD.team_entry_id
    OR NEW.member_org_id IS DISTINCT FROM OLD.member_org_id
    OR NEW.source_team_season_id IS DISTINCT FROM OLD.source_team_season_id
    OR NEW.roster IS DISTINCT FROM OLD.roster
    OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'federation roster snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER federation_roster_snapshot_immutable
  BEFORE UPDATE ON federation_roster_snapshots
  FOR EACH ROW EXECUTE FUNCTION federation_roster_snapshot_immutable_guard();
