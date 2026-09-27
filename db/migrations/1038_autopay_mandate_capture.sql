ALTER TABLE autopay_authorizations
  ADD COLUMN operation_key uuid,
  ADD COLUMN mandate_text_hash text CHECK (mandate_text_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX autopay_authorizations_operation_key_uq
  ON autopay_authorizations(org_id, operation_key)
  WHERE operation_key IS NOT NULL;
