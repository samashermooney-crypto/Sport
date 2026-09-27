ALTER TABLE tax_rates
  ADD COLUMN creation_key uuid,
  ADD COLUMN creation_hash text;

CREATE UNIQUE INDEX tax_rates_creation_idx
  ON tax_rates(org_id, creation_key)
  WHERE creation_key IS NOT NULL;
