ALTER TABLE official_pay_batches
  ADD COLUMN approved_by uuid REFERENCES accounts(id),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN paid_by uuid REFERENCES accounts(id),
  ADD COLUMN payment_reference text;
