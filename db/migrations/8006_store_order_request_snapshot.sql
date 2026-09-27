ALTER TABLE store_orders
  ADD COLUMN tax_rate_bps integer NOT NULL DEFAULT 0
    CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN request_hash text NOT NULL DEFAULT ''
    CHECK (length(request_hash) <= 64);

CREATE INDEX store_orders_invoice_recovery_idx
  ON store_orders(org_id, created_at)
  WHERE status = 'awaiting_payment' AND invoice_id IS NULL;
