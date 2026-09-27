CREATE INDEX payment_line_allocations_line_fk_idx
  ON payment_line_allocations(org_id, invoice_line_id);
