ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_invoice_line_unique
    UNIQUE (org_id, invoice_id, id);

ALTER TABLE payment_line_allocations
  ADD CONSTRAINT payment_line_allocations_invoice_line_fk
    FOREIGN KEY (org_id, invoice_id, invoice_line_id)
    REFERENCES invoice_lines(org_id, invoice_id, id);
