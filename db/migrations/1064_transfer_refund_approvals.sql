ALTER TABLE refund_approvals
  ADD COLUMN approval_scope text NOT NULL DEFAULT 'payment'
    CHECK (approval_scope IN ('payment', 'transfer_aggregate')),
  ADD COLUMN transfer_details jsonb;

ALTER TABLE refund_approvals
  ADD CONSTRAINT refund_approvals_transfer_details_check CHECK (
    (approval_scope = 'transfer_aggregate') = (transfer_details IS NOT NULL)
    AND (
      approval_scope <> 'transfer_aggregate'
      OR (
        destination = 'original_method'
        AND recipient IS NULL
        AND jsonb_typeof(transfer_details) = 'object'
        AND jsonb_typeof(transfer_details->'shares') = 'array'
        AND jsonb_array_length(transfer_details->'shares') >= 2
      )
    )
  );

CREATE INDEX refund_approvals_transfer_key_idx
  ON refund_approvals(org_id, operation_key)
  WHERE approval_scope = 'transfer_aggregate';
