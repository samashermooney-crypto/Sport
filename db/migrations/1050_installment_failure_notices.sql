ALTER TABLE finance_notice_outbox
  DROP CONSTRAINT finance_notice_outbox_kind_check,
  ADD CONSTRAINT finance_notice_outbox_kind_check
    CHECK (kind IN ('invoice_issued', 'payment_received', 'installment_failed', 'installment_final_notice')),
  DROP CONSTRAINT finance_notice_pdf_recipient,
  ADD CONSTRAINT finance_notice_pdf_recipient
    CHECK (attachment_pdf IS NULL OR delivery_email IS NOT NULL);
