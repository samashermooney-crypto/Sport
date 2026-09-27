CREATE TABLE background_check_disputes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  order_id uuid NOT NULL,
  candidate_account_id uuid NOT NULL REFERENCES accounts(id),
  statement_enc bytea NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'withdrawn')),
  resolution_enc bytea,
  resolved_by uuid REFERENCES accounts(id),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, order_id) REFERENCES background_check_orders(org_id, id),
  CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL) OR
         (status <> 'open' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX background_check_disputes_order_idx
  ON background_check_disputes(org_id, order_id, submitted_at DESC);
CREATE INDEX background_check_disputes_open_idx
  ON background_check_disputes(org_id, status, submitted_at)
  WHERE status = 'open';
SELECT configure_spine_tenant_table('background_check_disputes', true);
