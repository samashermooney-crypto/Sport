ALTER TABLE payments
  ADD COLUMN receipt_number bigint CHECK (receipt_number > 0);

CREATE UNIQUE INDEX payments_org_receipt_number_idx
  ON payments(org_id, receipt_number)
  WHERE receipt_number IS NOT NULL;
