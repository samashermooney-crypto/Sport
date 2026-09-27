CREATE INDEX invoice_lines_late_fee_invoice_fk_idx
  ON invoice_lines(org_id, invoice_id, late_fee_installment_id)
  WHERE late_fee_installment_id IS NOT NULL;
