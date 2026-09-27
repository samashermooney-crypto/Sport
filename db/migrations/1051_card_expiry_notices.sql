ALTER TABLE finance_notice_outbox
  DROP CONSTRAINT finance_notice_outbox_kind_check,
  ADD CONSTRAINT finance_notice_outbox_kind_check
    CHECK (kind IN ('invoice_issued', 'payment_received', 'installment_failed',
      'installment_final_notice', 'card_expiring'));
