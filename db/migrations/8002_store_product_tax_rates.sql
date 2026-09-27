ALTER TABLE product_variants ADD COLUMN tax_rate_id uuid;
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_tax_rate_fk
  FOREIGN KEY (org_id, tax_rate_id) REFERENCES tax_rates(org_id, id);
CREATE INDEX product_variants_tax_rate_idx
  ON product_variants(org_id, tax_rate_id) WHERE tax_rate_id IS NOT NULL;
