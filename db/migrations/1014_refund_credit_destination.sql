ALTER TABLE refunds
  ADD COLUMN destination text NOT NULL DEFAULT 'original_method'
    CHECK (destination IN ('original_method', 'credit')),
  ADD COLUMN credit_operation_key uuid,
  ADD COLUMN request_hash text,
  ADD COLUMN credit_id uuid;

ALTER TABLE refunds
  ADD CONSTRAINT refunds_credit_destination_check
    CHECK ((destination = 'credit') = (credit_operation_key IS NOT NULL AND credit_id IS NOT NULL)),
  ADD CONSTRAINT refunds_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT refunds_credit_fk
    FOREIGN KEY (org_id, credit_id) REFERENCES credits(org_id, id);

CREATE UNIQUE INDEX refunds_credit_key_idx
  ON refunds(org_id, credit_operation_key)
  WHERE credit_operation_key IS NOT NULL;
