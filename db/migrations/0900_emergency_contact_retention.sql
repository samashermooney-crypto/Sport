ALTER TABLE emergency_contacts
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

ALTER TABLE emergency_contacts
  DROP CONSTRAINT emergency_contacts_org_id_person_id_priority_key;

CREATE UNIQUE INDEX emergency_contacts_active_priority_unique
  ON emergency_contacts (org_id, person_id, priority)
  WHERE removed_at IS NULL;
