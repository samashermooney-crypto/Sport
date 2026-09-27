-- Track I: link tuition invoices to their subscription and track the next
-- annual registration-fee charge per enrollment.

ALTER TABLE class_enrollments
  ADD COLUMN annual_fee_next_on date;

CREATE TABLE tuition_invoices (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  tuition_subscription_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, tuition_subscription_id, period_start),
  FOREIGN KEY (org_id, tuition_subscription_id)
    REFERENCES tuition_subscriptions(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX tuition_invoices_subscription_idx
  ON tuition_invoices(org_id, tuition_subscription_id);
SELECT configure_spine_tenant_table('tuition_invoices');
