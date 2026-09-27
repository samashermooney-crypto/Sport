ALTER TABLE finance_notice_outbox
  ADD COLUMN delivery_email text,
  ADD CONSTRAINT finance_notice_pdf_recipient
    CHECK ((attachment_pdf IS NULL) = (delivery_email IS NULL));
