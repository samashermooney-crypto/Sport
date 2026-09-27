CREATE TABLE org_billing_invoices (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  stripe_invoice_id text NOT NULL UNIQUE CHECK (stripe_invoice_id LIKE 'in_%'),
  stripe_subscription_id text NOT NULL CHECK (stripe_subscription_id LIKE 'sub_%'),
  stripe_customer_id text NOT NULL CHECK (stripe_customer_id LIKE 'cus_%'),
  status text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void', 'unknown')),
  currency text NOT NULL CHECK (currency = 'usd'),
  total_cents bigint NOT NULL,
  amount_paid_cents bigint NOT NULL CHECK (amount_paid_cents >= 0),
  amount_due_cents bigint NOT NULL CHECK (amount_due_cents >= 0),
  stripe_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX org_billing_invoices_subscription_idx
  ON org_billing_invoices(org_id, stripe_subscription_id, stripe_created_at DESC);
SELECT configure_spine_tenant_table('org_billing_invoices');
