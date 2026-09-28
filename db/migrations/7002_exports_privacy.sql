-- Phase 14: org data export, privacy requests, retention sweep.

-- Full org export. The download link is a random bearer token stored hashed;
-- the artifact itself lives in org-scoped storage via the files module.
CREATE TABLE org_data_exports (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  requested_by uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'ready', 'failed', 'expired')),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_id uuid,
  bytes bigint,
  error text,
  expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX org_data_exports_org_idx ON org_data_exports(org_id, created_at DESC);
SELECT configure_spine_tenant_table('org_data_exports');

-- Bearer tokens for finished export downloads. SELECT is intentionally global
-- (the public download route resolves the token before entering tenant scope);
-- writes remain org-scoped like provider_delivery_keys.
CREATE TABLE export_download_tokens (
  token_hash text PRIMARY KEY,
  export_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, export_id)
);
ALTER TABLE export_download_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_download_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY export_download_tokens_lookup ON export_download_tokens FOR SELECT TO athlentry_app USING (true);
CREATE POLICY export_download_tokens_insert ON export_download_tokens FOR INSERT TO athlentry_app
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY export_download_tokens_update ON export_download_tokens FOR UPDATE TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE TRIGGER export_download_tokens_set_updated_at BEFORE UPDATE ON export_download_tokens FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON export_download_tokens TO athlentry_app;

-- Org-scoped privacy requests (04 §7): access export, correction, deletion.
CREATE TABLE org_privacy_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('access', 'correction', 'deletion')),
  subject_type text NOT NULL CHECK (subject_type IN ('person', 'household')),
  subject_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES accounts(id),
  contact_email citext,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'completed', 'rejected')),
  resolution_note text,
  completed_at timestamptz,
  completed_by uuid REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX org_privacy_requests_status_idx ON org_privacy_requests(org_id, status, created_at);
SELECT configure_spine_tenant_table('org_privacy_requests');

CREATE TABLE retention_policies (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT configure_spine_tenant_table('retention_policies');

CREATE TABLE retention_sweep_runs (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX retention_sweep_runs_idx ON retention_sweep_runs(org_id, started_at DESC);
SELECT configure_spine_tenant_table('retention_sweep_runs', true);
