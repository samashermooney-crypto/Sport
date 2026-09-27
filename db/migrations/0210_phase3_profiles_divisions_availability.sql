CREATE TABLE sport_profile_versions (
  org_id uuid NOT NULL REFERENCES organizations(id),
  sport_profile_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  profile jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sport_profile_id, version),
  FOREIGN KEY (org_id, sport_profile_id) REFERENCES sport_profiles(org_id, id)
);
CREATE INDEX sport_profile_versions_org_idx ON sport_profile_versions(org_id, sport_profile_id, version DESC);
ALTER TABLE sport_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sport_profile_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY sport_profile_versions_scope ON sport_profile_versions TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON sport_profile_versions TO athlentry_app;
INSERT INTO sport_profile_versions(org_id, sport_profile_id, version, profile, created_by)
SELECT p.org_id, p.id, p.version, p.profile,
  (SELECT a.id FROM accounts a ORDER BY a.created_at LIMIT 1)
FROM sport_profiles p
WHERE EXISTS (SELECT 1 FROM accounts)
ON CONFLICT DO NOTHING;

ALTER TABLE divisions ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX divisions_one_default_per_program_idx
  ON divisions(org_id, program_id) WHERE is_default;

ALTER TABLE space_availability ADD COLUMN recurrence jsonb;
ALTER TABLE allocations ADD COLUMN recurrence jsonb;
