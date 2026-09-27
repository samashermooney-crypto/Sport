ALTER TABLE financial_aid_programs
  ADD COLUMN creation_key uuid,
  ADD COLUMN creation_hash text;

CREATE UNIQUE INDEX financial_aid_program_creation_idx
  ON financial_aid_programs(org_id, creation_key)
  WHERE creation_key IS NOT NULL;
