CREATE TABLE billing_checkout_claims (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  request_key uuid NOT NULL,
  stripe_customer_id text NOT NULL CHECK (stripe_customer_id LIKE 'cus_%'),
  stripe_price_id text NOT NULL CHECK (stripe_price_id LIKE 'price_%'),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'external_started', 'created', 'fulfilled')),
  stripe_session_id text UNIQUE CHECK (stripe_session_id IS NULL OR stripe_session_id LIKE 'cs_%'),
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, request_key),
  CHECK ((stripe_session_id IS NULL) = (checkout_url IS NULL)),
  CHECK (status NOT IN ('created', 'fulfilled') OR stripe_session_id IS NOT NULL)
);
CREATE UNIQUE INDEX billing_checkout_one_active_idx ON billing_checkout_claims(org_id)
  WHERE status IN ('reserved', 'external_started', 'created');
CREATE INDEX billing_checkout_plan_idx ON billing_checkout_claims(plan_id);
SELECT configure_spine_tenant_table('billing_checkout_claims');
