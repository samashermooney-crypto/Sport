CREATE TABLE manual_installment_payment_attempts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  installment_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  operation_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN
    ('reserved', 'external_started', 'completed', 'failed_pre_external')),
  payment_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  application_fee_cents bigint NOT NULL
    CHECK (application_fee_cents >= 0 AND application_fee_cents < amount_cents),
  customer_id text NOT NULL,
  connected_account_id text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, operation_key),
  UNIQUE (org_id, payment_id),
  FOREIGN KEY (org_id, installment_id) REFERENCES installments(org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id)
);
CREATE INDEX manual_installment_payment_attempts_installment_idx
  ON manual_installment_payment_attempts(org_id, installment_id, status);
CREATE INDEX manual_installment_payment_attempts_account_idx
  ON manual_installment_payment_attempts(account_id);
SELECT configure_spine_tenant_table('manual_installment_payment_attempts', true);
