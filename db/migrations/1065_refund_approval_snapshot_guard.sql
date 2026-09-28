CREATE FUNCTION finance_refund_approval_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    OLD.id, OLD.org_id, OLD.payment_id, OLD.operation_key, OLD.destination,
    OLD.recipient, OLD.cancellation_date, OLD.amount_cents, OLD.request_hash,
    OLD.requested_by, OLD.approval_scope, OLD.transfer_details, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.org_id, NEW.payment_id, NEW.operation_key, NEW.destination,
    NEW.recipient, NEW.cancellation_date, NEW.amount_cents, NEW.request_hash,
    NEW.requested_by, NEW.approval_scope, NEW.transfer_details, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'refund approval snapshots are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refund_approval_snapshot_immutable
  BEFORE UPDATE ON refund_approvals
  FOR EACH ROW EXECUTE FUNCTION finance_refund_approval_snapshot_guard();
