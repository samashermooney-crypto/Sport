CREATE TABLE schedule_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  created_by uuid NOT NULL REFERENCES accounts(id),
  file_name text NOT NULL,
  source bytea,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'invalid', 'committing', 'committed', 'discarded', 'failed')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  result jsonb,
  error_message text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (org_id, created_by) REFERENCES org_memberships(org_id, account_id)
);
CREATE INDEX schedule_import_runs_org_created_idx ON schedule_import_runs(org_id, created_at DESC);
SELECT configure_spine_tenant_table('schedule_import_runs', true);
