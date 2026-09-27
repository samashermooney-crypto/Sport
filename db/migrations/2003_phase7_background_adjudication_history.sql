CREATE TABLE background_check_adjudication_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  order_id uuid NOT NULL,
  adjudication text NOT NULL CHECK (adjudication IN ('eligible', 'ineligible', 'pending')),
  reason_enc bytea NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  action_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, order_id) REFERENCES background_check_orders(org_id, id)
);
CREATE INDEX background_check_adjudications_order_idx ON background_check_adjudication_events(org_id, order_id, action_at DESC);
SELECT configure_spine_tenant_table('background_check_adjudication_events', true);
