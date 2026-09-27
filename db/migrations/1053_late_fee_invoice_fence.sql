ALTER TABLE installments
  ADD CONSTRAINT installments_invoice_id_id_unique
    UNIQUE (org_id, invoice_id, id);

ALTER TABLE invoice_lines
  DROP CONSTRAINT invoice_lines_late_fee_installment_fk;

ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_late_fee_installment_fk
    FOREIGN KEY (org_id, invoice_id, late_fee_installment_id)
    REFERENCES installments(org_id, invoice_id, id);
