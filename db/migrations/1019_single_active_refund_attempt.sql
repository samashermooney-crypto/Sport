CREATE UNIQUE INDEX refund_attempts_one_active_payment_idx
  ON refund_attempts(org_id, payment_id)
  WHERE status IN ('reserved', 'external_started');
