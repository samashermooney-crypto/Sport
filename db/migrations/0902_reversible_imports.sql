ALTER TABLE import_rows
  ADD COLUMN before_state jsonb,
  ADD COLUMN target_person_id uuid;
ALTER TABLE import_rows
  ADD CONSTRAINT import_rows_target_person_fk
  FOREIGN KEY (org_id, target_person_id) REFERENCES people (org_id, id);
ALTER TABLE import_rows
  DROP CONSTRAINT import_rows_action_check,
  ADD CONSTRAINT import_rows_action_check
  CHECK (action IN ('create', 'update', 'merge', 'skip', 'invalid'));
