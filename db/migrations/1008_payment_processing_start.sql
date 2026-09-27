ALTER TABLE payments ADD COLUMN processing_started_at timestamptz;

CREATE INDEX payments_processing_started_idx
  ON payments(org_id, processing_started_at)
  WHERE status = 'processing';
