ALTER TABLE invoices
  DROP CONSTRAINT invoices_balance_cents_check,
  DROP COLUMN balance_cents,
  ADD COLUMN disputed_cents bigint NOT NULL DEFAULT 0 CHECK (disputed_cents >= 0),
  ADD COLUMN dispute_lost_cents bigint NOT NULL DEFAULT 0 CHECK (dispute_lost_cents >= 0),
  ADD COLUMN balance_cents bigint GENERATED ALWAYS AS
    (total_cents - paid_cents - credit_applied_cents + refunded_cents + dispute_lost_cents) STORED,
  ADD CONSTRAINT invoices_balance_cents_check CHECK (balance_cents >= 0),
  ADD CONSTRAINT invoices_dispute_allocation_check
    CHECK (disputed_cents + dispute_lost_cents + refunded_cents <= paid_cents);

ALTER TABLE disputes
  ADD COLUMN invoice_id uuid,
  ADD COLUMN stripe_charge_id text,
  ADD COLUMN stripe_transfer_id text,
  ADD COLUMN fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  ADD COLUMN funds_withdrawn boolean NOT NULL DEFAULT false,
  ADD COLUMN funds_reinstated boolean NOT NULL DEFAULT false,
  ADD COLUMN accounting_state text NOT NULL DEFAULT 'warning'
    CHECK (accounting_state IN ('warning', 'active', 'won', 'lost')),
  ADD CONSTRAINT disputes_invoice_fk
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);

CREATE TABLE dispute_liability_movements (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  dispute_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('from_connected', 'to_connected')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  unrecovered_cents bigint NOT NULL DEFAULT 0 CHECK (unrecovered_cents >= 0),
  stripe_transfer_id text NOT NULL,
  stripe_movement_id text,
  state text NOT NULL CHECK (state IN ('reserved', 'external_started', 'completed', 'failed')),
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, dispute_id, direction),
  UNIQUE (idempotency_key),
  FOREIGN KEY (org_id, dispute_id) REFERENCES disputes(org_id, id)
);
CREATE INDEX dispute_liability_movements_state_idx
  ON dispute_liability_movements(org_id, state, created_at);
SELECT configure_spine_tenant_table('dispute_liability_movements');
