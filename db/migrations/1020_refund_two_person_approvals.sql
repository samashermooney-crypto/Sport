CREATE TABLE refund_approvals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  payment_id uuid NOT NULL,
  operation_key uuid NOT NULL,
  destination text NOT NULL CHECK (destination IN ('original_method', 'credit')),
  recipient text CHECK (recipient IN ('account', 'household')),
  cancellation_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  requested_by uuid NOT NULL REFERENCES accounts(id),
  approved_by uuid REFERENCES accounts(id),
  approved_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, operation_key),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id),
  CHECK ((destination = 'credit') = (recipient IS NOT NULL)),
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (requested_by IS DISTINCT FROM approved_by)
);
CREATE INDEX refund_approvals_pending_idx
  ON refund_approvals(org_id, status, created_at)
  WHERE status = 'pending';
SELECT configure_spine_tenant_table('refund_approvals');
