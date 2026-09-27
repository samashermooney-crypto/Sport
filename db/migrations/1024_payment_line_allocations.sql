CREATE TABLE payment_line_allocations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  invoice_line_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, payment_id, invoice_line_id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id),
  FOREIGN KEY (org_id, invoice_line_id) REFERENCES invoice_lines(org_id, id)
);

CREATE INDEX payment_line_allocations_invoice_idx
  ON payment_line_allocations(org_id, invoice_id, invoice_line_id);
SELECT configure_spine_tenant_table('payment_line_allocations', true);
