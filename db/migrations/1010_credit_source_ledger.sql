ALTER TABLE credits
  ADD COLUMN source_credit_id uuid,
  ADD COLUMN operation_key uuid,
  ADD COLUMN operation_line integer,
  ADD COLUMN request_hash text;

ALTER TABLE credits
  ADD CONSTRAINT credits_source_fk
    FOREIGN KEY (org_id, source_credit_id) REFERENCES credits(org_id, id),
  ADD CONSTRAINT credits_operation_line_check
    CHECK (operation_line IS NULL OR operation_line >= 0),
  ADD CONSTRAINT credits_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT credits_issue_positive_check
    CHECK (kind <> 'issued' OR amount_cents > 0),
  ADD CONSTRAINT credits_debit_negative_check
    CHECK (kind NOT IN ('applied', 'expired') OR amount_cents < 0);

CREATE UNIQUE INDEX credits_operation_line_idx
  ON credits(org_id, operation_key, operation_line)
  WHERE operation_key IS NOT NULL;
CREATE INDEX credits_source_idx ON credits(org_id, source_credit_id)
  WHERE source_credit_id IS NOT NULL;
