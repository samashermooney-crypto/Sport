ALTER TABLE invoice_lines
  ADD COLUMN checkout_line_index integer
  CHECK (checkout_line_index IS NULL OR checkout_line_index >= 0);

CREATE UNIQUE INDEX invoice_lines_checkout_order_idx
  ON invoice_lines(org_id, invoice_id, checkout_line_index)
  WHERE checkout_line_index IS NOT NULL;
