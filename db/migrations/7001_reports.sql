-- Phase 14: report builder persistence. Report definitions are JSON documents
-- validated against the curated dataset catalog in shared/src/reports.

CREATE TABLE saved_reports (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  dataset text NOT NULL,
  definition jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  shared_roles text[] NOT NULL DEFAULT '{}',
  is_preset boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX saved_reports_dataset_idx ON saved_reports(org_id, dataset);
SELECT configure_spine_tenant_table('saved_reports');

CREATE TABLE report_schedules (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  saved_report_id uuid NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  next_run_at timestamptz NOT NULL,
  recipients jsonb NOT NULL,
  delivery text NOT NULL CHECK (delivery IN ('link', 'csv_attachment')),
  format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'xlsx')),
  last_run_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, saved_report_id) REFERENCES saved_reports(org_id, id)
);
CREATE INDEX report_schedules_due_idx
  ON report_schedules(next_run_at)
  WHERE status = 'active';
SELECT configure_spine_tenant_table('report_schedules');

CREATE TABLE report_deliveries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  schedule_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients_count integer NOT NULL DEFAULT 0,
  delivery text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, schedule_id) REFERENCES report_schedules(org_id, id)
);
CREATE INDEX report_deliveries_schedule_idx ON report_deliveries(org_id, schedule_id, sent_at DESC);
SELECT configure_spine_tenant_table('report_deliveries', true);
