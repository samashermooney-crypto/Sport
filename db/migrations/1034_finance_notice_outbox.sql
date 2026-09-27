CREATE TABLE finance_notice_outbox (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('invoice_issued', 'payment_received')),
  source_id uuid NOT NULL,
  message_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  provider_message_id text,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, kind, source_id),
  UNIQUE (message_key),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX finance_notice_outbox_due_idx
  ON finance_notice_outbox(org_id, created_at)
  WHERE status IN ('queued', 'failed', 'sending');
SELECT configure_spine_tenant_table('finance_notice_outbox', true);
