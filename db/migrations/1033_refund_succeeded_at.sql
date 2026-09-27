ALTER TABLE refunds
  ADD COLUMN succeeded_at timestamptz;

CREATE INDEX refunds_succeeded_at_idx
  ON refunds(org_id, succeeded_at)
  WHERE status = 'succeeded';
