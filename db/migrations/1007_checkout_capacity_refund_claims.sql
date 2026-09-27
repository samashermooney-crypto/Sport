CREATE TABLE checkout_capacity_refund_claims (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  checkout_id uuid NOT NULL,
  payment_intent_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  stripe_refund_id text,
  refund_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, checkout_id, payment_intent_id),
  FOREIGN KEY (org_id, checkout_id) REFERENCES checkouts(org_id, id)
);
CREATE INDEX checkout_capacity_refund_claims_pending_idx
  ON checkout_capacity_refund_claims(org_id, created_at)
  WHERE stripe_refund_id IS NULL;
SELECT configure_spine_tenant_table('checkout_capacity_refund_claims');
