ALTER TABLE finance_notice_outbox
  ADD COLUMN attachment_pdf bytea,
  ADD CONSTRAINT finance_notice_pdf_size
    CHECK (attachment_pdf IS NULL OR octet_length(attachment_pdf) <= 2097152);
