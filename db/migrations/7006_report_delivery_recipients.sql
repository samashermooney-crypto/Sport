ALTER TABLE report_deliveries
  DROP CONSTRAINT report_deliveries_status_check,
  ADD CONSTRAINT report_deliveries_status_check
    CHECK (status IN ('sent', 'failed', 'suppressed'));

CREATE TABLE report_delivery_recipients (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  outbox_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, outbox_id, account_id),
  FOREIGN KEY (org_id, outbox_id)
    REFERENCES report_delivery_outbox(org_id, id)
);
CREATE INDEX report_delivery_recipients_outbox_idx
  ON report_delivery_recipients(org_id, outbox_id, status);
SELECT configure_spine_tenant_table('report_delivery_recipients');
