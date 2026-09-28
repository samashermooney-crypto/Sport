ALTER TABLE sponsors
  ADD COLUMN renewal_notified_at timestamptz;

CREATE INDEX sponsors_renewal_notice_idx
  ON sponsors(org_id, contract_end)
  WHERE status = 'active' AND renewal_notified_at IS NULL;
