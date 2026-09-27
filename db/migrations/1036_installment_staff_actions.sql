CREATE TABLE installment_staff_actions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  installment_id uuid NOT NULL,
  operation_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('change_due_date', 'split')),
  result jsonb NOT NULL,
  performed_by uuid NOT NULL REFERENCES accounts(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, operation_key),
  FOREIGN KEY (org_id, installment_id) REFERENCES installments(org_id, id)
);
CREATE INDEX installment_staff_actions_installment_idx
  ON installment_staff_actions(org_id, installment_id, created_at);
CREATE INDEX installment_staff_actions_performer_idx
  ON installment_staff_actions(performed_by);
SELECT configure_spine_tenant_table('installment_staff_actions', true);
