CREATE TABLE checkout_policy_acceptances (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  checkout_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  terms_hash text NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  terms_snapshot jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, checkout_id, terms_hash),
  FOREIGN KEY (org_id, checkout_id) REFERENCES checkouts(org_id, id)
);
CREATE INDEX checkout_policy_acceptances_checkout_idx
  ON checkout_policy_acceptances(org_id, checkout_id, accepted_at DESC);
CREATE INDEX checkout_policy_acceptances_account_idx
  ON checkout_policy_acceptances(account_id);
SELECT configure_spine_tenant_table('checkout_policy_acceptances', true);
