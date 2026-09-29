-- Durable tenant-scoped outbox for scheduled report delivery. The worker
-- claims and retries deliveries without retaining report contents in the DB.
CREATE TABLE report_delivery_outbox (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  schedule_id uuid NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, schedule_id, scheduled_for),
  FOREIGN KEY (org_id, schedule_id) REFERENCES report_schedules(org_id, id),
  CHECK ((status = 'sending') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX report_delivery_outbox_due_idx
  ON report_delivery_outbox(org_id, next_attempt_at, created_at)
  WHERE status IN ('queued', 'failed', 'sending');
SELECT configure_spine_tenant_table('report_delivery_outbox');
