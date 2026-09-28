ALTER TABLE divisions ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX divisions_one_default_per_program_idx
  ON divisions(org_id, program_id) WHERE is_default;
