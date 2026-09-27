CREATE TABLE discount_code_reservations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  discount_code_id uuid NOT NULL,
  checkout_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  redeemed_invoice_id uuid,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, checkout_id, discount_code_id),
  CHECK ((redeemed_invoice_id IS NULL) = (redeemed_at IS NULL)),
  CHECK (released_at IS NULL OR redeemed_at IS NULL),
  FOREIGN KEY (org_id, discount_code_id) REFERENCES discount_codes(org_id, id),
  FOREIGN KEY (org_id, checkout_id) REFERENCES checkouts(org_id, id),
  FOREIGN KEY (org_id, redeemed_invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX discount_code_reservations_code_active_idx
  ON discount_code_reservations(org_id, discount_code_id, expires_at)
  WHERE released_at IS NULL AND redeemed_at IS NULL;
CREATE INDEX discount_code_reservations_account_active_idx
  ON discount_code_reservations(org_id, discount_code_id, account_id, expires_at)
  WHERE released_at IS NULL AND redeemed_at IS NULL;
CREATE INDEX discount_code_reservations_invoice_idx
  ON discount_code_reservations(org_id, redeemed_invoice_id)
  WHERE redeemed_invoice_id IS NOT NULL;
CREATE INDEX discount_code_reservations_account_fk_idx
  ON discount_code_reservations(account_id);
SELECT configure_spine_tenant_table('discount_code_reservations');
