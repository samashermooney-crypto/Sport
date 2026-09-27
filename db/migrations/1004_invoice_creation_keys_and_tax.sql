ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_kind_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_kind_check
  CHECK (kind IN ('registration', 'add_on', 'product', 'team_fee', 'tuition',
    'volunteer_buyout', 'donation', 'service_fee', 'late_fee', 'adjustment',
    'discount', 'aid', 'tax'));

ALTER TABLE invoices
  ADD COLUMN creation_key uuid,
  ADD COLUMN creation_hash text CHECK (creation_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT invoices_creation_pair_check
    CHECK ((creation_key IS NULL) = (creation_hash IS NULL));

CREATE UNIQUE INDEX invoices_creation_key_idx ON invoices(org_id, creation_key)
  WHERE creation_key IS NOT NULL;
