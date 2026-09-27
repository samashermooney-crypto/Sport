ALTER TABLE invoice_lines
  ADD COLUMN late_fee_installment_id uuid;

ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_late_fee_kind_check
    CHECK (late_fee_installment_id IS NULL OR kind = 'late_fee'),
  ADD CONSTRAINT invoice_lines_late_fee_installment_fk
    FOREIGN KEY (org_id, late_fee_installment_id)
    REFERENCES installments(org_id, id);

CREATE UNIQUE INDEX invoice_lines_one_late_fee_per_installment
  ON invoice_lines(org_id, late_fee_installment_id)
  WHERE late_fee_installment_id IS NOT NULL;
