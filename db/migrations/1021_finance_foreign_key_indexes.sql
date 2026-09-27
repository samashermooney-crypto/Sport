CREATE INDEX refund_approvals_requested_by_idx
  ON refund_approvals(requested_by);
CREATE INDEX refund_approvals_approved_by_idx
  ON refund_approvals(approved_by)
  WHERE approved_by IS NOT NULL;
CREATE INDEX refund_approvals_payment_idx
  ON refund_approvals(org_id, payment_id);
CREATE INDEX installment_charge_attempts_account_idx
  ON installment_charge_attempts(account_id);
CREATE INDEX refunds_credit_idx
  ON refunds(org_id, credit_id)
  WHERE credit_id IS NOT NULL;
CREATE INDEX disputes_invoice_idx
  ON disputes(org_id, invoice_id)
  WHERE invoice_id IS NOT NULL;
