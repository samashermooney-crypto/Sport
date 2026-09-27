CREATE TABLE refund_attempts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  payment_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('reserved', 'external_started', 'completed', 'failed_pre_external')),
  result jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, payment_id, idempotency_key),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id),
  CHECK ((status = 'completed') = (result IS NOT NULL))
);
CREATE INDEX refund_attempts_payment_idx ON refund_attempts(org_id, payment_id, created_at DESC);
SELECT configure_spine_tenant_table('refund_attempts');
