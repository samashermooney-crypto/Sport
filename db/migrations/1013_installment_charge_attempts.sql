CREATE TABLE installment_charge_attempts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  installment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 4),
  status text NOT NULL CHECK (status IN ('reserved', 'external_started', 'recorded')),
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  customer_id text NOT NULL,
  connected_account_id text NOT NULL,
  payment_method_id text NOT NULL,
  method text NOT NULL CHECK (method IN ('card', 'us_bank_account', 'link')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  application_fee_cents bigint NOT NULL CHECK (application_fee_cents >= 0 AND application_fee_cents < amount_cents),
  stripe_payment_intent_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, installment_id, attempt_number),
  FOREIGN KEY (org_id, installment_id) REFERENCES installments(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX installment_charge_attempts_lease_idx
  ON installment_charge_attempts(org_id, lease_expires_at)
  WHERE status = 'reserved';
CREATE INDEX installment_charge_attempts_invoice_pending_idx
  ON installment_charge_attempts(org_id, invoice_id, status);
SELECT configure_spine_tenant_table('installment_charge_attempts');
