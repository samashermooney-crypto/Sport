DROP TRIGGER sport_profile_version_snapshot ON sport_profiles;

CREATE FUNCTION prepare_sport_profile_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.profile IS DISTINCT FROM OLD.profile THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sport_profile_version_prepare
  BEFORE UPDATE OF profile ON sport_profiles
  FOR EACH ROW EXECUTE FUNCTION prepare_sport_profile_version_update();

CREATE OR REPLACE FUNCTION snapshot_sport_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_id uuid := NULLIF(current_setting('app.actor_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.profile IS DISTINCT FROM OLD.profile THEN
    INSERT INTO sport_profile_versions (sport_profile_id, org_id, version, profile, created_by)
    VALUES (NEW.id, NEW.org_id, NEW.version, NEW.profile, actor_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sport_profile_version_snapshot
  AFTER INSERT OR UPDATE OF profile ON sport_profiles
  FOR EACH ROW EXECUTE FUNCTION snapshot_sport_profile_version();
