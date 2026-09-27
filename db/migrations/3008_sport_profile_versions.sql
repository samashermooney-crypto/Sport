CREATE TABLE sport_profile_versions (
  sport_profile_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  version integer NOT NULL CHECK (version >= 1),
  profile jsonb NOT NULL,
  created_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sport_profile_id, version),
  UNIQUE (org_id, sport_profile_id, version),
  FOREIGN KEY (org_id, sport_profile_id) REFERENCES sport_profiles(org_id, id)
);
INSERT INTO sport_profile_versions (sport_profile_id, org_id, version, profile)
SELECT id, org_id, version, profile FROM sport_profiles;
SELECT configure_spine_tenant_table('sport_profile_versions', true);

CREATE FUNCTION snapshot_sport_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_id uuid := NULLIF(current_setting('app.actor_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO sport_profile_versions (sport_profile_id, org_id, version, profile, created_by)
    VALUES (NEW.id, NEW.org_id, NEW.version, NEW.profile, actor_id);
  ELSIF NEW.profile IS DISTINCT FROM OLD.profile THEN
    NEW.version := OLD.version + 1;
    INSERT INTO sport_profile_versions (sport_profile_id, org_id, version, profile, created_by)
    VALUES (NEW.id, NEW.org_id, NEW.version, NEW.profile, actor_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sport_profile_version_snapshot
  BEFORE INSERT OR UPDATE OF profile ON sport_profiles
  FOR EACH ROW EXECUTE FUNCTION snapshot_sport_profile_version();

CREATE FUNCTION prevent_sport_profile_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sport_profile_versions are append-only';
END;
$$;
CREATE TRIGGER sport_profile_versions_append_only
  BEFORE UPDATE OR DELETE ON sport_profile_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_sport_profile_version_mutation();

ALTER TABLE contests
  ADD CONSTRAINT contests_profile_version_fk
  FOREIGN KEY (org_id, sport_profile_id, profile_version)
  REFERENCES sport_profile_versions(org_id, sport_profile_id, version);
