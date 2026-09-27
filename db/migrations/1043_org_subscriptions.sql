CREATE TABLE org_subscriptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  plan_id uuid REFERENCES plans(id),
  stripe_customer_id text NOT NULL UNIQUE CHECK (stripe_customer_id LIKE 'cus_%'),
  stripe_subscription_id text UNIQUE CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id LIKE 'sub_%'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'incomplete', 'incomplete_expired',
      'trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled')),
  current_period_end timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
SELECT configure_spine_tenant_table('org_subscriptions');
