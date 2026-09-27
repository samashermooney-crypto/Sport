ALTER TABLE invoices
  ADD COLUMN refund_terms jsonb,
  ADD CONSTRAINT invoices_refund_terms_object_check
    CHECK (refund_terms IS NULL OR jsonb_typeof(refund_terms) = 'object');
