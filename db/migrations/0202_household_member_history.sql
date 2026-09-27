ALTER TABLE household_members ADD COLUMN removed_at timestamptz;
ALTER TABLE household_members DROP CONSTRAINT household_members_org_id_household_id_person_id_key;
CREATE UNIQUE INDEX household_members_active_person_key
  ON household_members(org_id, household_id,person_id) WHERE removed_at IS NULL;
CREATE INDEX household_members_active_household_idx
  ON household_members(org_id,household_id) WHERE removed_at IS NULL;
