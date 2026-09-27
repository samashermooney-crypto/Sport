ALTER TABLE product_variants
  ADD COLUMN low_stock_threshold integer
    CHECK (low_stock_threshold IS NULL OR low_stock_threshold BETWEEN 0 AND 100000),
  ADD COLUMN low_stock_notified_at timestamptz;

CREATE INDEX product_variants_low_stock_idx
  ON product_variants(org_id, low_stock_threshold)
  WHERE low_stock_threshold IS NOT NULL AND archived_at IS NULL;
